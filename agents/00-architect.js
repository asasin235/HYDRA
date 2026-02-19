import cron from 'node-cron';
import axios from 'axios';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { getLogs, getDebt, setState } from '../core/db.js';
import { getMonthlySpend, getTodaySpend } from '../core/bottleneck.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_STATUS_CHANNEL = '#00-architect';

const architect = new Agent({
  name: '00-architect',
  model: 'google/gemini-flash-3',
  systemPromptPath: 'prompts/00-architect.txt',
  tools: [],
  namespace: '00_ARCHITECT',
  tokenBudget: 500000
});

const AGENTS = [
  '00-architect','01-edmobot','02-brandbot','03-sahibabot','05-jarvis','06-cfobot','07-biobot','09-wolf','10-mercenary','11-auditor','99-slack-gateway'
];

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: SLACK_STATUS_CHANNEL,
      text
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }});
  } catch (e) {
    console.error('[00-architect] Slack post error:', e.message);
  }
}

function today() {
  return new Date().toISOString().split('T')[0];
}

async function gatherTodaySummaries() {
  const date = today();
  const sections = [];
  for (const a of AGENTS) {
    try {
      const rows = getLogs(a, 1) || [];
      const todays = rows.filter(r => r.date === date);
      if (todays.length) {
        const combined = todays.map(r => (r.summary || '')).join('\n');
        sections.push(`Agent ${a}:\n${combined}`);
      }
    } catch (e) {
      console.error('[00-architect] gather logs error for', a, e.message);
    }
  }
  return sections.join('\n\n');
}

async function buildMorningBrief() {
  try {
    const logsText = await gatherTodaySummaries();
    const spend = await getMonthlySpend();
    const debt = getDebt();

    const context = [
      `Budget month ${spend.month}: total=$${spend.total.toFixed(2)}, remaining=$${spend.remaining.toFixed(2)}`,
      `Debt tracker: debt=$${(debt?.debt||0).toFixed(2)} paid=$${(debt?.paid||0).toFixed(2)} wedding=$${(debt?.wedding_fund||0).toFixed(2)}`,
      'Today logs by agent:',
      logsText || '(no logs found)'
    ].join('\n');

    const msg = await architect.run('Produce today\'s morning briefing for HYDRA.', context);
    await postSlack(msg);
  } catch (e) {
    console.error('[00-architect] morning brief failed:', e.message);
  }
}

async function buildEveningSummary() {
  try {
    const logsText = await gatherTodaySummaries();
    const perAgent = await Promise.all(AGENTS.map(async (a) => ({ name: a, ...(await getTodaySpend(a)) })));
    const totalToday = perAgent.reduce((s, x) => s + (x.cost || 0), 0);

    const context = [
      `Today token spend total: $${totalToday.toFixed(4)}`,
      perAgent.map(a => `• ${a.name}: $${(a.cost||0).toFixed(4)}`).join('\n'),
      'Today logs by agent:',
      logsText || '(no logs found)'
    ].join('\n');

    const msg = await architect.run('Generate HYDRA evening summary: wins, failures, actionable follow-ups.', context);
    await postSlack(msg);

    // Update goal tracker in DB instead of filesystem JSON
    const metrics = {
      date: today(),
      spend_today: totalToday,
      notes: 'Auto-updated by 00-architect based on evening summary.'
    };
    setState('00-architect', 'goal_tracker', metrics);
  } catch (e) {
    console.error('[00-architect] evening summary failed:', e.message);
  }
}

// Watchdog: check agent heartbeats every 30 minutes
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const AGENT_NAMESPACES = {
  '01-edmobot':      '01_EDMO',
  '02-brandbot':     '02_BRAND',
  '03-sahibabot':    '03_SAHIBA',
  '05-jarvis':       '05_JARVIS',
  '06-cfobot':       '06_CFO',
  '07-biobot':       '07_BIO',
  '09-wolf':         '09_WOLF',
  '10-mercenary':    '10_MERCENARY',
  '11-auditor':      '11_AUDITOR',
  '99-slack-gateway':'99_GATEWAY'
};

function getPm2OnlineAgents() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 5000 }).toString();
    const list = JSON.parse(raw);
    return list.filter(p => p.pm2_env?.status === 'online').map(p => p.name);
  } catch {
    return [];
  }
}

async function runWatchdog() {
  try {
    const onlineAgents = getPm2OnlineAgents();
    const now = Date.now();
    const STALE_MS = 15 * 60 * 1000; // 15 minutes
    for (const [agentName, ns] of Object.entries(AGENT_NAMESPACES)) {
      if (!onlineAgents.includes(agentName)) continue;
      const hbFile = path.join(BRAIN_PATH, 'brain', ns, 'heartbeat.json');
      const exists = await fs.pathExists(hbFile);
      if (!exists) continue; // never written yet — skip
      try {
        const hb = await fs.readJson(hbFile);
        const age = now - (hb.ts || 0);
        if (age > STALE_MS) {
          const minutesAgo = Math.floor(age / 60000);
          await postSlack(`⚠️ ${agentName} is online but not responding (last heartbeat: ${minutesAgo}m ago). Possible deadlock.`);
        }
      } catch (e) {
        console.error('[00-architect] watchdog read error for', agentName, e.message);
      }
    }
  } catch (e) {
    console.error('[00-architect] watchdog error:', e.message);
  }
}

// 6AM daily
cron.schedule('0 6 * * *', async () => { await buildMorningBrief(); }, { timezone: process.env.TZ || 'UTC' });

// 10PM daily
cron.schedule('0 22 * * *', async () => { await buildEveningSummary(); }, { timezone: process.env.TZ || 'UTC' });

// Watchdog every 30 minutes
cron.schedule('*/30 * * * *', async () => { await runWatchdog(); }, { timezone: process.env.TZ || 'UTC' });

// Optional immediate run when started with flags
if (process.argv.includes('--morning-now')) {
  buildMorningBrief();
}
if (process.argv.includes('--evening-now')) {
  buildEveningSummary();
}
if (process.argv.includes('--watchdog-now')) {
  runWatchdog();
}
