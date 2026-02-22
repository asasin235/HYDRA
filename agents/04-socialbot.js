/**
 * 04-socialbot.js — Social proxy agent (OpenClaw integration)
 * Receives incoming chat messages from OpenClaw Gateway via webhook,
 * drafts replies using Claude Haiku with Aatif's personality prompt,
 * posts drafts to Slack for human-in-the-loop approval,
 * sends approved replies back through OpenClaw.
 */
import cron from 'node-cron';
import axios from 'axios';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { writeBrain, readBrain, appendBrain } from '../core/filesystem.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#04-socialbot';
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const SOCIAL_DIR = path.join(BRAIN_PATH, 'brain', '04_SOCIAL');
const DRAFTS_FILE = path.join(SOCIAL_DIR, 'pending_drafts.json');

// OpenClaw Gateway
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:3100';
const WEBHOOK_PORT = Number(process.env.SOCIAL_WEBHOOK_PORT || 3004);

// Daily budget: $1/day for SocialBot
const DAILY_BUDGET_TOKENS = 50000;
let tokensUsedToday = 0;
let lastResetDate = new Date().toISOString().split('T')[0];

const social = new Agent({
  name: '04-socialbot',
  model: 'anthropic/claude-haiku-4-5',
  systemPromptPath: 'prompts/04-socialbot.txt',
  tools: [],
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

import { sendMessage as openclawSend } from '../core/openclaw.js';

async function executeSend(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) return { error: 'Draft not found' };

  try {
    const result = await openclawSend(draft.channel, draft.contact, draft.message);

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

// ── Webhook server: receives messages from OpenClaw ──────────────────────────

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
    dailyBudget: DAILY_BUDGET_TOKENS,
    openclawUrl: OPENCLAW_URL
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
