import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#07-biobot';
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const HEALTH_DATA_DIR = path.join(BRAIN_PATH, 'brain', '07_BIOBOT', 'health_data');
const STREAKS_FILE = path.join(BRAIN_PATH, 'brain', '07_BIOBOT', 'streaks.json');

const biobot = new Agent({
  name: '07-biobot',
  model: 'google/gemini-flash-3',
  systemPromptPath: 'prompts/07-biobot.txt',
  tools: [],
  namespace: '07_BIOBOT',
  tokenBudget: 200000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[07-biobot] Slack post error:', e.message);
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function readHealthData() {
  try {
    const exists = await fs.pathExists(HEALTH_DATA_DIR);
    if (!exists) return null;
    const files = (await fs.readdir(HEALTH_DATA_DIR))
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-1); // latest file

    if (!files.length) return null;
    const data = await fs.readJson(path.join(HEALTH_DATA_DIR, files[0]));
    return {
      hrv: data.hrv ?? null,
      sleepHours: data.sleepHours ?? null,
      sleepStart: data.sleepStart ?? null,
      sleepEnd: data.sleepEnd ?? null,
      steps: data.steps ?? null,
      restingHR: data.restingHR ?? null,
      activeEnergy: data.activeEnergy ?? null,
      date: data.date || files[0].replace('.json', '')
    };
  } catch (e) {
    console.error('[07-biobot] readHealthData error:', e.message);
    return null;
  }
}

async function updateStreaks(data) {
  try {
    const existing = (await fs.pathExists(STREAKS_FILE)) ? await fs.readJson(STREAKS_FILE) : {};
    const today = new Date().toISOString().split('T')[0];

    const walked = (data?.steps ?? 0) >= 7500;
    const slept7h = (data?.sleepHours ?? 0) >= 7;
    const hrvOk = (data?.hrv ?? 0) >= 40;

    // Streak logic: increment if today's condition met, else reset
    const walkStreak = walked
      ? (existing.walkStreak?.lastDate === yesterday() ? (existing.walkStreak.count || 0) + 1 : 1)
      : 0;
    const sleepStreak = slept7h
      ? (existing.sleepStreak?.lastDate === yesterday() ? (existing.sleepStreak.count || 0) + 1 : 1)
      : 0;
    const hrvStreak = hrvOk
      ? (existing.hrvStreak?.lastDate === yesterday() ? (existing.hrvStreak.count || 0) + 1 : 1)
      : 0;

    const streaks = {
      walkStreak: { count: walkStreak, lastDate: today, met: walked },
      sleepStreak: { count: sleepStreak, lastDate: today, met: slept7h },
      hrvStreak: { count: hrvStreak, lastDate: today, met: hrvOk },
      updatedAt: today
    };

    await fs.ensureDir(path.dirname(STREAKS_FILE));
    await fs.writeJson(STREAKS_FILE, streaks, { spaces: 2 });
    return streaks;
  } catch (e) {
    console.error('[07-biobot] updateStreaks error:', e.message);
    return {};
  }
}

function yesterday() {
  return new Date(Date.now() - 86400000).toISOString().split('T')[0];
}

function readinessScore(data) {
  if (!data) return { score: 'unknown', label: 'No health data available' };
  const hrv = data.hrv ?? 0;
  if (hrv >= 45) return { score: 'good', hrv, label: `HRV ${hrv} — Good readiness ✅` };
  if (hrv >= 30) return { score: 'moderate', hrv, label: `HRV ${hrv} — Moderate readiness ⚠️` };
  return { score: 'low', hrv, label: `HRV ${hrv} — Low readiness 🔴 (rest or light work only)` };
}

// ── Cron ─────────────────────────────────────────────────────────────────────

// 6AM morning brief
cron.schedule('0 6 * * *', async () => {
  try {
    const data = await readHealthData();
    const streaks = await updateStreaks(data);
    const readiness = readinessScore(data);
    const ctx = JSON.stringify({ ...data, streaks, readiness }, null, 2);

    const brief = await biobot.run(
      'Generate a concise morning health brief: readiness score, sleep quality, today\'s recommendation (train hard / moderate / rest), and streak status. Max 5 bullets.',
      ctx
    );
    await postSlack(`*Morning Health Brief*\n${readiness.label}\n${brief}`);
  } catch (e) {
    console.error('[07-biobot] morning brief failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// 3PM: walk nudge if steps < 3000 and HRV >= 35
cron.schedule('0 15 * * *', async () => {
  try {
    const data = await readHealthData();
    if (!data) return;
    const steps = data.steps ?? 0;
    const hrv = data.hrv ?? 0;
    if (steps < 3000 && hrv >= 35) {
      await postSlack(`🚶 *Walk nudge:* Only ${steps} steps today and HRV is ${hrv} (capacity available). Take a 20-min walk — it'll help.`);
    }
  } catch (e) {
    console.error('[07-biobot] 3PM walk nudge failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// 10PM: evening summary + sleep target
cron.schedule('0 22 * * *', async () => {
  try {
    const data = await readHealthData();
    const streaks = (await fs.pathExists(STREAKS_FILE)) ? await fs.readJson(STREAKS_FILE) : {};
    const ctx = JSON.stringify({ ...data, streaks }, null, 2);

    const summary = await biobot.run(
      'Generate a brief evening health summary: today\'s steps vs target (7500), sleep debt, HRV trend, and recommended sleep time tonight. 3-4 bullets only.',
      ctx
    );
    await postSlack(`*Evening Health Summary*\n${summary}`);
  } catch (e) {
    console.error('[07-biobot] evening summary failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

export { readHealthData, updateStreaks };

if (process.argv.includes('--brief-now')) {
  readHealthData().then(data => {
    const r = readinessScore(data);
    console.log(r);
  });
}
