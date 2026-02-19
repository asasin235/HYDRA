/**
 * 03-sahibabot.js — Relationship health agent for Sabiha
 * Tier 1: nudges, promise tracking, calendar reminders
 * Tier 2: WhatsApp-style message drafts via Slack commands
 */
import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { writeBrain, readBrain } from '../core/filesystem.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#03-sahibabot';
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const SAHIBA_DIR = path.join(BRAIN_PATH, 'brain', '03_SABIHA');
const MEMORIES_DIR = path.join(SAHIBA_DIR, 'memories');

// Tier 1: Mistral for lightweight nudges
const sahibaTier1 = new Agent({
  name: '03-sahibabot',
  model: 'mistral/mistral-small-latest',
  systemPromptPath: 'prompts/03-sahibabot.txt',
  tools: [],
  namespace: '03_SAHIBA',
  tokenBudget: 100000
});

// Tier 2: Claude Haiku for message drafts (warmer, more contextual)
const sahibaTier2 = new Agent({
  name: '03-sahibabot-t2',
  model: 'anthropic/claude-haiku-4-5',
  systemPromptPath: 'prompts/03-sahibabot.txt',
  tools: [],
  namespace: '03_SAHIBA',
  tokenBudget: 200000
});

async function postSlack(text, blocks) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    const payload = { channel: SLACK_CHANNEL, text };
    if (blocks) payload.blocks = blocks;
    await axios.post('https://slack.com/api/chat.postMessage', payload, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[03-sahibabot] Slack post error:', e.message);
  }
}

// ── Tier 1 Tools ──────────────────────────────────────────────────────────────

async function readRelationshipContext() {
  try {
    const lastContactFile = path.join(SAHIBA_DIR, 'last_contact.json');
    const eventsFile = path.join(SAHIBA_DIR, 'upcoming_events.json');
    const memoriesFiles = (await fs.pathExists(MEMORIES_DIR))
      ? (await fs.readdir(MEMORIES_DIR)).filter(f => f.endsWith('.json') || f.endsWith('.txt')).sort().slice(-20)
      : [];

    const lastContact = (await fs.pathExists(lastContactFile))
      ? await fs.readJson(lastContactFile)
      : { timestamp: null };

    const events = (await fs.pathExists(eventsFile))
      ? await fs.readJson(eventsFile)
      : [];

    const memorySnippets = [];
    for (const f of memoriesFiles.slice(-5)) {
      try {
        const content = await fs.readFile(path.join(MEMORIES_DIR, f), 'utf-8');
        memorySnippets.push(content.slice(0, 300));
      } catch {}
    }

    // Health score: 1-10 based on last contact age and upcoming events
    let score = 10;
    if (lastContact.timestamp) {
      const ageHours = (Date.now() - new Date(lastContact.timestamp).getTime()) / 3600000;
      if (ageHours > 48) score -= 5;
      else if (ageHours > 24) score -= 3;
      else if (ageHours > 12) score -= 1;
    }
    const upcomingCount = Array.isArray(events) ? events.filter(e => {
      const d = new Date(e.date || e.datetime || '');
      return d > new Date() && d < new Date(Date.now() + 30 * 86400000);
    }).length : 0;
    if (upcomingCount > 0) score = Math.min(10, score + 1);

    return { lastContact, events, memorySnippets, healthScore: score };
  } catch (e) {
    console.error('[03-sahibabot] readRelationshipContext error:', e.message);
    return { lastContact: {}, events: [], memorySnippets: [], healthScore: 5 };
  }
}

async function extractPromises(transcript) {
  try {
    const promisesFile = path.join(SAHIBA_DIR, 'promises.json');
    const existing = (await fs.pathExists(promisesFile)) ? await fs.readJson(promisesFile) : [];

    // Pattern matching for implicit promises
    const promisePatterns = /\b(i[''']?ll|i will|i plan to|we should|let[''']?s|i[''']?m going to)\s+(.{10,80})/gi;
    const found = [];
    let match;
    while ((match = promisePatterns.exec(transcript)) !== null) {
      found.push({
        id: Date.now() + '-' + found.length,
        text: match[0].slice(0, 120),
        extracted: new Date().toISOString(),
        due: null, // AI-inferred deadline placeholder
        done: false
      });
    }

    if (found.length > 0) {
      const merged = [...existing, ...found];
      await fs.writeJson(promisesFile, merged, { spaces: 2 });
    }
    return found;
  } catch (e) {
    console.error('[03-sahibabot] extractPromises error:', e.message);
    return [];
  }
}

// ── Tier 2 Tool ───────────────────────────────────────────────────────────────

async function draftMessage(context) {
  try {
    // Read last 10 transcripts mentioning Sabiha
    const memories = [];
    if (await fs.pathExists(MEMORIES_DIR)) {
      const files = (await fs.readdir(MEMORIES_DIR)).filter(f => f.endsWith('.txt') || f.endsWith('.json')).sort().slice(-10);
      for (const f of files) {
        try {
          const content = await fs.readFile(path.join(MEMORIES_DIR, f), 'utf-8');
          if (/sabiha/i.test(content)) memories.push(content.slice(0, 400));
        } catch {}
      }
    }

    const timelineFile = path.join(SAHIBA_DIR, 'relationship_timeline.md');
    const timeline = (await fs.pathExists(timelineFile))
      ? await fs.readFile(timelineFile, 'utf-8')
      : '(no timeline yet)';

    const prompt = `Draft a WhatsApp message for Aatif to send to Sabiha.
Requirements:
- Sound EXACTLY like Aatif — casual Delhi/Pakistani tone, warm but not clingy
- Use Hinglish naturally if appropriate (not forced)  
- No formal language, no AI-sounding phrases
- Keep it natural: max 3-5 sentences
- Context given: ${context}
Output ONLY the message text, nothing else.`;

    return await sahibaTier2.run(prompt, [
      `Recent memories:\n${memories.join('\n\n---\n\n')}`,
      `Relationship timeline:\n${timeline.slice(0, 1000)}`
    ].join('\n\n'));
  } catch (e) {
    return `draftMessage error: ${e.message}`;
  }
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

// 4PM daily: nudge if last contact > 18 hours
cron.schedule('0 16 * * *', async () => {
  try {
    const ctx = await readRelationshipContext();
    const lastTs = ctx.lastContact?.timestamp;
    const ageHours = lastTs ? (Date.now() - new Date(lastTs).getTime()) / 3600000 : 999;

    if (ageHours > 18) {
      const summary = `Last contact: ${ageHours.toFixed(0)}h ago. Health: ${ctx.healthScore}/10. Recent memories: ${ctx.memorySnippets[0]?.slice(0, 100) || 'none'}`;
      const nudge = await sahibaTier1.run('Suggest a warm, specific nudge to reconnect with Sabiha. 1 sentence only.', summary);
      await postSlack(`*Sabiha Nudge* (${ageHours.toFixed(0)}h since last contact, health: ${ctx.healthScore}/10)\n${nudge}`);
    }
  } catch (e) {
    console.error('[03-sahibabot] 4PM nudge failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Monday: check calendar for events in 30 days
cron.schedule('0 9 * * 1', async () => {
  try {
    const ctx = await readRelationshipContext();
    const events = Array.isArray(ctx.events) ? ctx.events.filter(e => {
      const d = new Date(e.date || e.datetime || '');
      const daysAway = (d.getTime() - Date.now()) / 86400000;
      return daysAway >= 6 && daysAway <= 8; // 7-day window
    }) : [];

    if (events.length > 0) {
      const eventList = events.map(e => `• ${e.name || e.title}: ${e.date || e.datetime}`).join('\n');
      await postSlack(`*Upcoming Events (7-day reminder):*\n${eventList}`);
    }
  } catch (e) {
    console.error('[03-sahibabot] Monday calendar check failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Daily: check promises due tomorrow
cron.schedule('0 20 * * *', async () => {
  try {
    const promisesFile = path.join(SAHIBA_DIR, 'promises.json');
    if (!await fs.pathExists(promisesFile)) return;
    const promises = await fs.readJson(promisesFile);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const due = promises.filter(p => !p.done && p.due && p.due.startsWith(tomorrow));
    if (due.length > 0) {
      const list = due.map(p => `• ${p.text}`).join('\n');
      await postSlack(`*Promises due tomorrow:*\n${list}`);
    }
  } catch (e) {
    console.error('[03-sahibabot] promises check failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// ── Exported Handlers (for Slack gateway routing) ─────────────────────────────

export async function handleSlackCommand(text) {
  const lower = text.toLowerCase();
  if (lower.includes('draft')) {
    const context = text.replace(/@hydra sahibabot draft/i, '').trim();
    const draft = await draftMessage(context || 'no specific context given');
    // Post with action buttons
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*Draft message:*\n${draft}` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Send as-is' }, value: `send:${draft.slice(0, 200)}`, action_id: 'sabiha_send' },
          { type: 'button', text: { type: 'plain_text', text: '✏️ Edit' }, value: `edit:${draft.slice(0, 200)}`, action_id: 'sabiha_edit' },
          { type: 'button', text: { type: 'plain_text', text: '🗑️ Discard' }, value: 'discard', action_id: 'sabiha_discard', style: 'danger' }
        ]
      }
    ];
    await postSlack('Message draft ready:', blocks);
    return draft;
  }
  const ctx = await readRelationshipContext();
  return await sahibaTier1.run(text, JSON.stringify(ctx));
}

export { readRelationshipContext, extractPromises, draftMessage };
