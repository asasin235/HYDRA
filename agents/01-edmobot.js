import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { writeBrain, brainPath } from '../core/filesystem.js';

validateEnv('01-edmobot');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#01-edmobot';
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const SCREEN_CTX_DIR = path.join(BRAIN_PATH, 'brain', '01_EDMO', 'screen_context');

const edmo = new Agent({
  name: '01-edmobot',
  model: 'anthropic/claude-sonnet-4',
  systemPromptPath: 'prompts/01-edmobot.txt',
  tools: [],
  namespace: '01_EDMO',
  tokenBudget: 300000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[01-edmobot] Slack post error:', e.message);
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function readScreenpipeContext() {
  try {
    const exists = await fs.pathExists(SCREEN_CTX_DIR);
    if (!exists) return { jira_tickets: [], open_files: [], slack_threads: [] };
    const files = (await fs.readdir(SCREEN_CTX_DIR))
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-10); // latest 10

    const jira_tickets = new Set();
    const open_files = new Set();
    const slack_threads = [];

    for (const f of files) {
      try {
        const data = await fs.readJson(path.join(SCREEN_CTX_DIR, f));
        const entries = Array.isArray(data) ? data : [data];
        for (const entry of entries) {
          const text = entry.text || entry.ocr_text || '';
          // Jira ticket pattern: PROJ-1234
          const jiraMatches = text.match(/[A-Z]+-\d+/g) || [];
          jiraMatches.forEach(t => jira_tickets.add(t));
          // Open files: paths containing common extensions
          const fileMatches = text.match(/[\w./\\-]+\.(js|ts|py|go|json|yaml|yml|md)\b/g) || [];
          fileMatches.forEach(f => open_files.add(f));
          // Slack threads: messages with reply context
          if (entry.app_name?.toLowerCase().includes('slack') && text.length > 50) {
            slack_threads.push(text.slice(0, 200));
          }
        }
      } catch {}
    }

    return {
      jira_tickets: [...jira_tickets].slice(0, 20),
      open_files: [...open_files].slice(0, 20),
      slack_threads: slack_threads.slice(0, 5)
    };
  } catch (e) {
    console.error('[01-edmobot] readScreenpipeContext error:', e.message);
    return { jira_tickets: [], open_files: [], slack_threads: [] };
  }
}

async function createJiraDescription(ticketId, context) {
  try {
    const contextStr = typeof context === 'object' ? JSON.stringify(context) : context;
    const prompt = `Generate a detailed Jira description for ticket ${ticketId}. Include:
1. Problem Statement (2-3 sentences)
2. Acceptance Criteria (bullet list)
3. Technical Approach (step-by-step)
4. Effort Estimate (hours)
Format as Jira wiki markup.`;
    return await edmo.run(prompt, `Context from screenpipe: ${contextStr}`);
  } catch (e) {
    return `createJiraDescription error: ${e.message}`;
  }
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

// 9AM daily work brief
cron.schedule('0 9 * * *', async () => {
  try {
    const ctx = await readScreenpipeContext();
    const ctxStr = JSON.stringify(ctx, null, 2);
    const brief = await edmo.run(
      'Produce today\'s work brief: list active Jira tickets with status, files being worked on, and any urgent Slack threads. Be concise.',
      `Yesterday\'s screenpipe context:\n${ctxStr}`
    );
    await postSlack(`*Daily Work Brief*\n${brief}`);
  } catch (e) {
    console.error('[01-edmobot] morning brief failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Friday 5PM: weekly accomplishments
cron.schedule('0 17 * * 5', async () => {
  try {
    const ctx = await readScreenpipeContext();
    const ctxStr = JSON.stringify(ctx, null, 2);
    const summary = await edmo.run(
      'Generate a concise weekly accomplishments summary. List completed tickets, key decisions made, and metrics. Suitable for a performance review.',
      `This week\'s screenpipe context:\n${ctxStr}`
    );
    const date = new Date().toISOString().split('T')[0];
    const perfPath = await brainPath('01_EDMO', `weekly_perf_${date}.md`);
    await fs.writeFile(perfPath, summary, 'utf-8');
    await postSlack(`*Weekly Performance Summary saved* to weekly_perf_${date}.md\n${summary.slice(0, 500)}`);
  } catch (e) {
    console.error('[01-edmobot] weekly summary failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Export for Slack command routing
export { readScreenpipeContext, createJiraDescription };

if (process.argv.includes('--brief-now')) {
  readScreenpipeContext().then(ctx => edmo.run('Produce work brief.', JSON.stringify(ctx))).then(console.log);
}
