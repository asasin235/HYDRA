/**
 * 04-socialbot.js — Social proxy agent (Hermes Gateway integration)
 * Drafts replies to incoming WhatsApp/Telegram/Discord messages,
 * posts drafts to Slack for human-in-the-loop approval,
 * sends approved replies through Hermes (native messaging gateway).
 */
import cron from 'node-cron';
import axios from 'axios';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { writeBrain, readBrain, appendBrain } from '../core/filesystem.js';
import {
  triageEmails, searchEmails, getEmail, sendEmail,
  getAgenda, NOT_AUTHED_MSG,
} from '../core/gws.js';

validateEnv('04-socialbot');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#04-socialbot';
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const SOCIAL_DIR = path.join(BRAIN_PATH, 'brain', '04_SOCIAL');
const DRAFTS_FILE = path.join(SOCIAL_DIR, 'pending_drafts.json');

// Webhook port for receiving messages from OpenClaw hooks
const WEBHOOK_PORT = Number(process.env.SOCIAL_WEBHOOK_PORT || 3004);

// Daily budget: $1/day for SocialBot
const DAILY_BUDGET_TOKENS = 50000;
let tokensUsedToday = 0;
let lastResetDate = new Date().toISOString().split('T')[0];

const social = new Agent({
  name: '04-socialbot',
  model: 'anthropic/claude-haiku-4-5',
  systemPromptPath: 'prompts/04-socialbot.txt',
  tools: [
    {
      name: 'check_personal_email',
      description: 'List recent unread emails from the personal inbox (aatif20@gmail.com).',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'number', description: 'Max emails to return (default: 15)' },
          hours: { type: 'number', description: 'Only show emails newer than N hours (optional)' }
        },
        required: []
      },
      execute: async ({ max = 15, hours } = {}) => {
        const query = hours
          ? `is:unread in:inbox newer_than:${hours}h -category:promotions -category:social`
          : 'is:unread in:inbox -category:promotions -category:social';
        const emails = await triageEmails('personal', { max, query });
        if (!emails) return NOT_AUTHED_MSG;
        if (emails.length === 0) return '✉️ No unread personal emails.';
        return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}\n   ${(e.snippet || '').slice(0, 150)}`).join('\n\n');
      }
    },
    {
      name: 'search_personal_email',
      description: 'Search personal Gmail (aatif20@gmail.com) with a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query, e.g. "from:friend@gmail.com"' },
          max: { type: 'number', description: 'Max results (default: 10)' }
        },
        required: ['query']
      },
      execute: async ({ query, max = 10 }) => {
        const emails = await searchEmails('personal', query, max);
        if (!emails) return NOT_AUTHED_MSG;
        if (emails.length === 0) return `No personal emails found for: "${query}"`;
        return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}`).join('\n');
      }
    },
    {
      name: 'send_personal_email',
      description: 'Send an email from the personal account (aatif20@gmail.com).',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' }
        },
        required: ['to', 'subject', 'body']
      },
      execute: async ({ to, subject, body }) => {
        try {
          await sendEmail('personal', { to, subject, body });
          return `✅ Personal email sent to ${to}: "${subject}"`;
        } catch (err) {
          return `❌ Failed to send: ${err.message}`;
        }
      }
    },
    {
      name: 'reply_to_email',
      description: 'Reply to an email using the same account the email was sent to. Detects personal vs work from the message ID context.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Reply-to email address' },
          subject: { type: 'string', description: 'Subject (prefix with Re: if needed)' },
          body: { type: 'string', description: 'Reply body text' }
        },
        required: ['to', 'subject', 'body']
      },
      execute: async ({ to, subject, body }) => {
        try {
          await sendEmail('personal', { to, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`, body });
          return `✅ Reply sent to ${to}`;
        } catch (err) {
          return `❌ Failed to reply: ${err.message}`;
        }
      }
    },
    {
      name: 'check_personal_calendar',
      description: 'List upcoming personal calendar events (aatif20@gmail.com).',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days ahead to look (default: 2)' },
          today_only: { type: 'boolean', description: "Only show today's events" }
        },
        required: []
      },
      execute: async ({ days = 2, today_only = false } = {}) => {
        const events = await getAgenda('personal', { days, today: today_only });
        if (!events) return NOT_AUTHED_MSG;
        if (events.length === 0) return '📅 No upcoming personal calendar events.';
        return events.map(e => {
          const start = e.start?.dateTime || e.start?.date || '';
          const end = e.end?.dateTime || e.end?.date || '';
          return `📅 ${e.summary} | ${start} → ${end}${e.location ? ` | 📍 ${e.location}` : ''}`;
        }).join('\n');
      }
    },
  ],
  namespace: '04_SOCIAL',
  tokenBudget: DAILY_BUDGET_TOKENS
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postSlack(text, blocks) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    const payload = { channel: SLACK_CHANNEL, text };
    if (blocks) payload.blocks = blocks;
    await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (e) {
    console.error('[04-socialbot] Slack post error:', e.message);
  }
}

function resetDailyBudget() {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    tokensUsedToday = 0;
    lastResetDate = today;
  }
}

function withinDailyBudget() {
  resetDailyBudget();
  return tokensUsedToday < DAILY_BUDGET_TOKENS;
}

// ── Pending drafts ───────────────────────────────────────────────────────────

async function saveDraft(draftId, draft) {
  try {
    await fs.ensureDir(SOCIAL_DIR);
    const existing = (await fs.pathExists(DRAFTS_FILE))
      ? await fs.readJson(DRAFTS_FILE)
      : {};
    existing[draftId] = draft;
    await fs.writeJson(DRAFTS_FILE, existing, { spaces: 2 });
  } catch (e) {
    console.error('[04-socialbot] saveDraft error:', e.message);
  }
}

async function getDraft(draftId) {
  try {
    const exists = await fs.pathExists(DRAFTS_FILE);
    if (!exists) return null;
    const drafts = await fs.readJson(DRAFTS_FILE);
    return drafts[draftId] || null;
  } catch {
    return null;
  }
}

async function removeDraft(draftId) {
  try {
    const exists = await fs.pathExists(DRAFTS_FILE);
    if (!exists) return;
    const drafts = await fs.readJson(DRAFTS_FILE);
    delete drafts[draftId];
    await fs.writeJson(DRAFTS_FILE, drafts, { spaces: 2 });
  } catch (e) {
    console.error('[04-socialbot] removeDraft error:', e.message);
  }
}

// ── Core: Draft a reply ──────────────────────────────────────────────────────

async function draftReply(channel, contact, message, threadHistory) {
  if (!withinDailyBudget()) {
    console.log('[04-socialbot] Daily budget reached, skipping.');
    return;
  }

  try {
    // Build context from thread history
    const historyText = Array.isArray(threadHistory)
      ? threadHistory.map(m => `${m.from || 'them'}: ${m.text}`).join('\n')
      : '';

    const context = [
      `App: ${channel}`,
      `Contact: ${contact}`,
      historyText ? `Recent thread:\n${historyText}` : ''
    ].filter(Boolean).join('\n');

    const prompt = `Draft a reply to the last message in this ${channel} conversation with ${contact}. The last message is: "${message}"`;

    const draft = await social.run(prompt, context);

    if (!draft || draft.startsWith('Agent ') || draft.includes('budget exceeded')) {
      console.log(`[04-socialbot] Skipping ${channel}:${contact}: ${draft?.slice(0, 80)}`);
      return;
    }

    const draftId = `social_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Save draft for later execution
    await saveDraft(draftId, {
      channel,
      contact,
      message: draft,
      originalMessage: message,
      createdAt: new Date().toISOString()
    });

    // Post to Slack with Block Kit approve/edit/discard
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${channel} — ${contact}*\n> _${message.slice(0, 200)}_\n\n*Draft reply:*\n${draft}`
        }
      },
      {
        type: 'actions',
        block_id: `social_${draftId}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📤 Send Now' },
            value: draftId,
            action_id: 'social_send',
            style: 'primary'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit' },
            value: draftId,
            action_id: 'social_edit'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🗑️ Discard' },
            value: draftId,
            action_id: 'social_discard',
            style: 'danger'
          }
        ]
      }
    ];

    await postSlack(`Draft reply for ${contact} on ${channel}`, blocks);

    // Log the draft
    await appendBrain('04_SOCIAL', `drafts_${new Date().toISOString().split('T')[0]}.json`, {
      draftId,
      channel,
      contact,
      original: message,
      draft,
      timestamp: new Date().toISOString()
    });

    tokensUsedToday += 2000;
    console.log(`[04-socialbot] Draft created for ${contact} on ${channel}`);
  } catch (e) {
    console.error(`[04-socialbot] draftReply error:`, e.message);
  }
}

import { sendMessage as hermesSend } from '../core/hermes-bridge.js';

async function executeSend(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { error: 'Draft not found' };

  try {
    const result = await hermesSend(draft.channel, draft.contact, draft.message);

    if (!result.success) {
      return { error: result.error };
    }

    await removeDraft(draftId);

    // Log successful send
    await appendBrain('04_SOCIAL', `sent_${new Date().toISOString().split('T')[0]}.json`, {
      draftId,
      channel: draft.channel,
      contact: draft.contact,
      message: draft.message,
      sentAt: new Date().toISOString()
    });

    return { success: true, channel: draft.channel, contact: draft.contact };
  } catch (e) {
    console.error('[04-socialbot] executeSend error:', e.message);
    return { error: e.message };
  }
}

// ── Webhook server: receives messages from Hermes Gateway ──────────────────────────
// Hermes posts incoming messages here via its webhook integration
const webhookApp = express();
webhookApp.use(express.json());

// OpenClaw sends incoming messages here
webhookApp.post('/social/incoming', async (req, res) => {
  try {
    const { channel, contact, message, threadHistory } = req.body;

    if (!channel || !message) {
      return res.status(400).json({ error: 'Missing channel or message' });
    }

    console.log(`[04-socialbot] Incoming ${channel} from ${contact}: ${message.slice(0, 80)}`);

    // Draft reply asynchronously (don't block the webhook response)
    draftReply(channel, contact || 'unknown', message, threadHistory || [])
      .catch(e => console.error('[04-socialbot] async draft error:', e.message));

    res.json({ ok: true, status: 'drafting' });
  } catch (e) {
    console.error('[04-socialbot] webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Health check
webhookApp.get('/social/health', (req, res) => {
  res.json({
    agent: '04-socialbot',
    status: 'healthy',
    tokensUsedToday,
    dailyBudget: DAILY_BUDGET_TOKENS
  });
});

webhookApp.listen(WEBHOOK_PORT, '127.0.0.1', () => {
  console.log(`[04-socialbot] Webhook server listening on http://127.0.0.1:${WEBHOOK_PORT}`);
});

// ── Daily summary at 9PM ─────────────────────────────────────────────────────

cron.schedule('0 21 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const draftsLog = path.join(SOCIAL_DIR, `drafts_${today}.json`);
    const sentLog = path.join(SOCIAL_DIR, `sent_${today}.json`);

    let draftsCount = 0;
    let sentCount = 0;

    if (await fs.pathExists(draftsLog)) {
      const data = await fs.readJson(draftsLog);
      draftsCount = Array.isArray(data) ? data.length : 0;
    }
    if (await fs.pathExists(sentLog)) {
      const data = await fs.readJson(sentLog);
      sentCount = Array.isArray(data) ? data.length : 0;
    }

    if (draftsCount > 0 || sentCount > 0) {
      await postSlack(`*Daily Social Summary*\n📝 Drafts created: ${draftsCount}\n📤 Messages sent: ${sentCount}\n💰 Tokens used: ~${tokensUsedToday}`);
    }
  } catch (e) {
    console.error('[04-socialbot] daily summary error:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// ── Exported for Slack gateway ────────────────────────────────────────────────

export { draftReply, executeSend, getDraft, removeDraft };

if (process.argv.includes('--test-webhook')) {
  // Quick test: simulate an incoming message
  axios.post(`http://127.0.0.1:${WEBHOOK_PORT}/social/incoming`, {
    channel: 'whatsapp',
    contact: 'Test User',
    message: 'bro you coming for gaming tonight?',
    threadHistory: [
      { from: 'Test User', text: 'yo' },
      { from: 'Test User', text: 'bro you coming for gaming tonight?' }
    ]
  }).then(r => console.log('[test]', r.data)).catch(e => console.error('[test]', e.message));
}
