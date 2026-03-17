import cron from 'node-cron';
import axios from 'axios';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { getLogs, getDebt, setState, listRecordingBriefs, listActionItems, getProjectSummary } from '../core/db.js';
import { readBrain } from '../core/filesystem.js';
import { getMonthlySpend, getTodaySpend, getWeeklySpend } from '../core/bottleneck.js';
import { AGENT_NAMES, AGENT_NAMESPACES } from '../core/registry.js';
import { readRecentContext, readTodayScreenActivity, readTodayAudioTranscripts } from '../core/openclaw-memory.js';
import { getMessages } from '../core/hermes-bridge.js';

validateEnv('00-architect');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_STATUS_CHANNEL = '#00-architect';

const architect = new Agent({
  name: '00-architect',
  model: 'google/gemini-2.5-flash',
  systemPromptPath: 'prompts/00-architect.txt',
  tools: [],
  namespace: '00_ARCHITECT',
  tokenBudget: 500000
});

// Agent list imported from registry — no more hardcoded duplicates
const AGENTS = AGENT_NAMES;

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: SLACK_STATUS_CHANNEL,
      text
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[00-architect] Slack post error:', e.message);
  }
}

function today() {
  return new Date().toISOString().split('T')[0];
}

async function gatherTodaySummaries() {
  const date = today();
  const filename = `daily_log_${date}.json`;
  const sections = [];
  for (const a of AGENTS) {
    try {
      const ns = AGENT_NAMESPACES[a];
      if (!ns) continue;
      const entries = await readBrain(ns, filename);
      if (!Array.isArray(entries) || entries.length === 0) continue;
      const summaries = entries.map(e => {
        const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '??:??';
        const tokens = (e.usage?.inputTokens || 0) + (e.usage?.outputTokens || 0);
        const resp = (e.response || '').slice(0, 200);
        return `[${time}] (${tokens} tok) ${resp}`;
      });
      sections.push(`**${a}** (${entries.length} runs):\n${summaries.join('\n')}`);
    } catch (e) {
      console.error('[00-architect] gather logs error for', a, e.message);
    }
  }
  return sections.join('\n\n');
}

async function gatherWeekLogs() {
  const sections = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
    const filename = `daily_log_${d}.json`;
    for (const a of AGENTS) {
      try {
        const ns = AGENT_NAMESPACES[a];
        if (!ns) continue;
        const entries = await readBrain(ns, filename);
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const summaries = entries.map(e => {
          const tokens = (e.usage?.inputTokens || 0) + (e.usage?.outputTokens || 0);
          return `  [${d}] (${tokens} tok) ${(e.response || '').slice(0, 150)}`;
        });
        sections.push(`**${a}** — ${d} (${entries.length} runs):\n${summaries.join('\n')}`);
      } catch (e) {
        // skip missing files silently
      }
    }
  }
  return sections.join('\n\n') || '(no logs found for the past 7 days)';
}

async function buildMorningBrief() {
  try {
    const logsText = await gatherTodaySummaries();
    const spend = await getMonthlySpend();
    const debt = getDebt();

    // Pull shared brain context for richer briefs
    let screenCtx = '';
    let audioCtx = '';
    let notesCtx = '';
    let socialPulse = '';
    try {
      screenCtx = await readRecentContext('screen', 1);
      audioCtx = await readRecentContext('audio', 1);
      notesCtx = await readRecentContext('notes', 1);

      const [wa_sabiha] = await Promise.allSettled([
        getMessages('whatsapp', 'Sabiha', 3)
      ]);

      if (wa_sabiha.status === 'fulfilled' && wa_sabiha.value?.length) {
        socialPulse += 'WhatsApp (Sabiha): ' + wa_sabiha.value.map(m => `"${m.text}"`).join(' | ') + '\n';
      }
    } catch (e) {
      console.error('[00-architect] context/pulse read error:', e.message);
    }

    // Pull recording intelligence from triage pipeline
    let recordingCtx = '';
    try {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const recentBriefs = listRecordingBriefs({ since: yesterday, limit: 20 });
      const meaningful = recentBriefs.filter(b => b.one_line && !b.one_line.includes('unintelligible') && !b.one_line.includes('noise'));
      if (meaningful.length) {
        recordingCtx = meaningful.map(b => {
          const actions = (typeof b.action_items_json === 'string' ? JSON.parse(b.action_items_json) : b.action_items_json) || [];
          const actStr = actions.length ? actions.map(a => `  → ${typeof a === 'string' ? a : a.task}`).join('\n') : '';
          return `• [${b.project}/${b.meeting_type}] ${b.one_line}${actStr ? '\n' + actStr : ''}`;
        }).join('\n');
      }
      const openActions = listActionItems({ status: 'open', limit: 15 });
      if (openActions.length) {
        recordingCtx += '\n\nOpen Action Items:\n' + openActions.map(a =>
          `• [${a.project}] ${a.task}${a.owner ? ' (@' + a.owner + ')' : ''}${a.due_date ? ' due ' + a.due_date : ''}`
        ).join('\n');
      }
      const projSummary = getProjectSummary();
      if (projSummary.length) {
        recordingCtx += '\n\nProject Activity Summary:\n' + projSummary.map(p =>
          `• ${p.project}: ${p.recording_count} recordings, ${p.open_actions} open actions`
        ).join('\n');
      }
    } catch (e) {
      console.error('[00-architect] recording context error:', e.message);
    }

    const context = [
      `Budget month ${spend.month}: total=$${spend.total.toFixed(2)}, remaining=$${spend.remaining.toFixed(2)}`,
      `Debt tracker: debt=$${(debt?.debt || 0).toFixed(2)} paid=$${(debt?.paid || 0).toFixed(2)} wedding=$${(debt?.wedding_fund || 0).toFixed(2)}`,
      'Today logs by agent:',
      logsText || '(no logs found)',
      screenCtx ? `\nRecent Screen Activity:\n${screenCtx.slice(0, 2000)}` : '',
      audioCtx ? `\nRecent Call/Audio Notes:\n${audioCtx.slice(0, 2000)}` : '',
      notesCtx ? `\nAgent Notes:\n${notesCtx.slice(0, 1000)}` : '',
      socialPulse ? `\nSocial Pulse (Unread/Recent messages):\n${socialPulse.slice(0, 1000)}` : '',
      recordingCtx ? `\nRecording Intelligence (last 24h):\n${recordingCtx.slice(0, 3000)}` : ''
    ].filter(Boolean).join('\n');

    const msg = await architect.run('Produce today\'s morning briefing for HYDRA. Include insights from screen activity, call recordings, agent notes, and social pulse if available.', context);
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
      perAgent.map(a => `• ${a.name}: $${(a.cost || 0).toFixed(4)}`).join('\n'),
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

// ─── Phase 5: Weekly Memory Digest ───────────────────────────────────────────
// Runs every Sunday at 9:00 PM.
// Summarises the past 7 days across all agents: memory facts, recordings,
// token spend, macro-goal alignment, and one directive for the week ahead.
async function buildWeeklyMemoryDigest() {
  try {
    const weekLogs = await gatherWeekLogs();

    // Week token spend per agent
    let weekSpendCtx = '';
    try {
      if (typeof getWeeklySpend === 'function') {
        const perAgent = await Promise.all(AGENTS.map(async (a) => ({ name: a, ...(await getWeeklySpend(a)) })));
        const totalWeek = perAgent.reduce((s, x) => s + (x.cost || 0), 0);
        weekSpendCtx = `Weekly token spend total: $${totalWeek.toFixed(4)}\n` +
          perAgent.map(a => `• ${a.name}: $${(a.cost || 0).toFixed(4)}`).join('\n');
      }
    } catch (e) {
      console.error('[00-architect] weekly spend error:', e.message);
    }

    // Debt snapshot
    const debt = getDebt();
    const debtCtx = `Debt snapshot: debt=₹${(debt?.debt || 0).toFixed(0)} paid=₹${(debt?.paid || 0).toFixed(0)} wedding_fund=₹${(debt?.wedding_fund || 0).toFixed(0)}`;

    // Recording intelligence for the past 7 days
    let recordingCtx = '';
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const weekBriefs = listRecordingBriefs({ since: sevenDaysAgo, limit: 50 });
      const meaningful = weekBriefs.filter(b => b.one_line && !b.one_line.includes('unintelligible') && !b.one_line.includes('noise'));
      if (meaningful.length) {
        recordingCtx = 'Recordings this week:\n' + meaningful.map(b => {
          const actions = (typeof b.action_items_json === 'string' ? JSON.parse(b.action_items_json) : b.action_items_json) || [];
          const actStr = actions.length ? actions.map(a => `  → ${typeof a === 'string' ? a : a.task}`).join('\n') : '';
          return `• [${b.project}/${b.meeting_type}] ${b.one_line}${actStr ? '\n' + actStr : ''}`;
        }).join('\n');
      }
      const openActions = listActionItems({ status: 'open', limit: 20 });
      if (openActions.length) {
        recordingCtx += '\n\nStill-open action items:\n' + openActions.map(a =>
          `• [${a.project}] ${a.task}${a.owner ? ' (@' + a.owner + ')' : ''}${a.due_date ? ' due ' + a.due_date : ''}`
        ).join('\n');
      }
    } catch (e) {
      console.error('[00-architect] weekly recording context error:', e.message);
    }

    // Recent audio/notes context (wider window)
    let audioCtx = '';
    let notesCtx = '';
    try {
      audioCtx = await readRecentContext('audio', 7);
      notesCtx = await readRecentContext('notes', 7);
    } catch (e) {
      console.error('[00-architect] weekly context read error:', e.message);
    }

    const context = [
      '=== WEEKLY MEMORY DIGEST — CONTEXT ===',
      debtCtx,
      weekSpendCtx,
      '\nAgent logs (past 7 days):',
      weekLogs,
      audioCtx ? `\nAudio / Call Notes (past 7 days):\n${audioCtx.slice(0, 3000)}` : '',
      notesCtx ? `\nAgent Notes (past 7 days):\n${notesCtx.slice(0, 2000)}` : '',
      recordingCtx ? `\n${recordingCtx.slice(0, 4000)}` : ''
    ].filter(Boolean).join('\n');

    const prompt = `Generate the Phase 5 Weekly Memory Digest for HYDRA.

Structure your output exactly as follows:

*📅 Weekly Memory Digest — Week of ${today()}*

*🧠 Top Interactions Reviewed*
• List the most significant conversations, recordings, or events processed this week.

*📌 Memory Facts Extracted*
• Key facts, decisions, or tasks that were written to memory this week.

*🎯 Macro-Goal Alignment Scores*
• Marriage (Sabiha, Oct 2027): X/10 — one sentence rationale
• Debt clearance (₹12.5L): X/10 — one sentence rationale
• Physical / Mental Health: X/10 — one sentence rationale

*🔁 Recurring Patterns*
• Habits, blockers, or behaviours worth flagging from this week.

*➡️ Next Week's Single Focus*
One clear directive. No hedging.

Be ruthless but fair. Use concrete data from the logs above.`;

    const msg = await architect.run(prompt, context);
    await postSlack(msg);

    // Persist digest summary to state
    setState('00-architect', 'weekly_digest', {
      week_ending: today(),
      generated_at: new Date().toISOString(),
      notes: 'Auto-generated by Phase 5 Weekly Memory Digest.'
    });
  } catch (e) {
    console.error('[00-architect] weekly digest failed:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Watchdog: check agent heartbeats every 30 minutes
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
// Agent namespace map imported from core/registry.js

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

// 10:45 AM daily
cron.schedule('45 10 * * *', async () => { await buildMorningBrief(); }, { timezone: process.env.TZ || 'UTC' });

// 10PM daily
cron.schedule('0 22 * * *', async () => { await buildEveningSummary(); }, { timezone: process.env.TZ || 'UTC' });

// Watchdog every 30 minutes
cron.schedule('*/30 * * * *', async () => { await runWatchdog(); }, { timezone: process.env.TZ || 'UTC' });

// Phase 5: Weekly Memory Digest — every Sunday at 9:00 PM
cron.schedule('0 21 * * 0', async () => { await buildWeeklyMemoryDigest(); }, { timezone: process.env.TZ || 'UTC' });

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
if (process.argv.includes('--weekly-digest-now')) {
  buildWeeklyMemoryDigest();
}
