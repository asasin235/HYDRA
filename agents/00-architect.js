import cron from 'node-cron';
import axios from 'axios';
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

// 6AM daily
cron.schedule('0 6 * * *', async () => { await buildMorningBrief(); }, { timezone: process.env.TZ || 'UTC' });

// 10PM daily
cron.schedule('0 22 * * *', async () => { await buildEveningSummary(); }, { timezone: process.env.TZ || 'UTC' });

// Optional immediate run when started with flags
if (process.argv.includes('--morning-now')) {
  buildMorningBrief();
}
if (process.argv.includes('--evening-now')) {
  buildEveningSummary();
}
