import { App } from '@slack/bolt';
import { existsSync } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import Agent from '../core/agent.js';
import { getMonthlySpend, getTodaySpend } from '../core/bottleneck.js';
import { getDebt } from '../core/db.js';
import { appendBrain } from '../core/filesystem.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const PI_SMB_PATH = process.env.PI_SMB_PATH || './brain';

function assertEnv() {
  const missing = [];
  if (!SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!SLACK_SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET');
  if (!SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN');
  if (missing.length) {
    console.error('[slack-gateway] Missing env:', missing.join(', '));
    process.exit(1);
  }
}

assertEnv();

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  appToken: SLACK_APP_TOKEN,
  socketMode: true
});

// Lazy agent registry
const agentRegistry = new Map();

// Dedup and rate limiting
const processed = new Set(); // store last 1000 event IDs
const lastByUser = new Map(); // user -> timestamp ms

function remember(id) {
  processed.add(id);
  if (processed.size > 1000) {
    // remove oldest by recreating set from last 1000 entries
    const arr = Array.from(processed);
    processed.clear();
    for (const v of arr.slice(-1000)) processed.add(v);
  }
}

async function logDrop(entry) {
  try {
    await appendBrain('errors', 'slack_drops.json', { ...entry, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[slack-gateway] drop log error:', e.message);
  }
}

function getOrCreateAgent(name) {
  if (agentRegistry.has(name)) return agentRegistry.get(name);
  // Sensible defaults; individual agents can be specialized later
  const agent = new Agent({
    name,
    model: 'anthropic/claude-sonnet-4',
    systemPromptPath: path.join('prompts', `${name}.md`),
    tools: [],
    namespace: name,
    tokenBudget: 8000
  });
  agentRegistry.set(name, agent);
  return agent;
}

// Utility to write pending action results
async function writePendingAction(agentName, approved) {
  try {
    const nsDir = path.join(PI_SMB_PATH, 'brain', agentName);
    await fs.ensureDir(nsDir);
    const file = path.join(nsDir, 'pending_action.json');
    await fs.writeJson(file, { approved, ts: Date.now() }, { spaces: 2 });
  } catch (e) {
    console.error('[slack-gateway] writePendingAction error:', e.message);
  }
}

// Message router: "@hydra [agent] [message]"
app.message(/^\s*@?hydra\s+(\S+)\s+([\s\S]+)/i, async ({ message, say, context }) => {
  try {
    // Verify channel name begins with hydra-
    const channel = context?.channelName || '';
    if (!channel.startsWith('hydra-')) return;

    const evtId = `${message.channel}:${message.ts}`;
    if (processed.has(evtId)) {
      // duplicate delivery
      await logDrop({ reason: 'duplicate', evtId, user: message.user, text: message.text });
      return;
    }
    remember(evtId);

    const user = message.user;
    const now = Date.now();
    const last = lastByUser.get(user) || 0;
    if (now - last < 3000) {
      await say({ thread_ts: message.ts, text: 'Please wait before sending another command' });
      await logDrop({ reason: 'rate_limited', evtId, user, text: message.text });
      return;
    }
    lastByUser.set(user, now);

    const agentName = context.matches[1].trim();
    const userText = context.matches[2].trim();

    const agent = getOrCreateAgent(agentName);

    await say({
      thread_ts: message.ts,
      text: `🤖 ${agentName} is thinking...`
    });

    // Timeout after 30s with a notice, but continue processing
    const runPromise = agent.run(userText, `Slack user: <@${user}> in #${channel}`);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 30000));
    const race = await Promise.race([runPromise, timeoutPromise]);

    if (race === 'TIMEOUT') {
      await say({ thread_ts: message.ts, text: `Agent ${agentName} is processing... check #${channel} for response` });
      // When finished, post the actual response
      try {
        const response = await runPromise;
        await say({ thread_ts: message.ts, text: `*${agentName}:* ${response}` });
      } catch (e) {
        console.error('[slack-gateway] delayed run error:', e.message);
      }
    } else {
      await say({ thread_ts: message.ts, text: `*${agentName}:* ${race}` });
    }
  } catch (error) {
    console.error('[slack-gateway] message handler error:', error.message);
    await say({
      thread_ts: message.ts,
      text: `Error: ${error.message}`
    });
  }
});

// Approve/Reject actions
app.action('hydra_approve', async ({ body, ack, say }) => {
  await ack();
  try {
    const agentName = body.actions?.[0]?.value || 'unknown';
    await writePendingAction(agentName, true);
    await say({ text: `✅ Approved for ${agentName}` });
  } catch (e) {
    console.error('[slack-gateway] approve action error:', e.message);
  }
});

app.action('hydra_reject', async ({ body, ack, say }) => {
  await ack();
  try {
    const agentName = body.actions?.[0]?.value || 'unknown';
    await writePendingAction(agentName, false);
    await say({ text: `❌ Rejected for ${agentName}` });
  } catch (e) {
    console.error('[slack-gateway] reject action error:', e.message);
  }
});

// /hydra-status command
app.command('/hydra-status', async ({ ack, respond }) => {
  await ack();
  try {
    // PM2 status via API
    const pm2 = await import('pm2');
    const processes = await new Promise((resolve, reject) => {
      pm2.connect(err => {
        if (err) return reject(err);
        pm2.list((err2, list) => {
          pm2.disconnect();
          return err2 ? reject(err2) : resolve(list || []);
        });
      });
    });

    const statuses = processes.map(p => ({ name: p.name, status: p.pm2_env?.status }));

    // Token spend today for known agents in ecosystem
    const agentNames = [
      '00-architect','01-edmobot','02-brandbot','03-sahibabot','05-jarvis','06-cfobot','07-biobot','09-wolf','10-mercenary','11-auditor','99-slack-gateway'
    ];
    const today = await Promise.all(agentNames.map(async n => ({ name: n, ...(await getTodaySpend(n)) })));
    const todayTotal = today.reduce((sum, a) => sum + (a.cost || 0), 0);

    // Debt tracker from SQLite
    const debt = getDebt();

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '*HYDRA Status*' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*PM2*' } },
      { type: 'section', text: { type: 'mrkdwn', text: statuses.map(s => `• ${s.name}: ${s.status}`).join('\n') || 'No processes' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Today Token Spend:* $${todayTotal.toFixed(4)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: today.map(a => `• ${a.name}: $${(a.cost || 0).toFixed(4)}`).join('\n') } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Debt:* Debt: $${(debt?.debt || 0).toFixed(2)} | Paid: $${(debt?.paid || 0).toFixed(2)} | Wedding: $${(debt?.wedding_fund || 0).toFixed(2)}` } }
    ];

    await respond({ blocks, text: 'HYDRA Status' });
  } catch (error) {
    console.error('[slack-gateway] /hydra-status error:', error.message);
    await respond({ text: `Status error: ${error.message}` });
  }
});

(async () => {
  try {
    await app.start();
    console.log('[slack-gateway] Bolt app running in socket mode');
  } catch (error) {
    console.error('[slack-gateway] failed to start:', error.message);
    process.exit(1);
  }
})();
