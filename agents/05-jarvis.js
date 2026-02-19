import cron from 'node-cron';
import axios from 'axios';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';

validateEnv();

const HA_URL = process.env.HOME_ASSISTANT_URL || 'http://192.168.68.124:8123';
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#05-jarvis';

const jarvis = new Agent({
  name: '05-jarvis',
  model: 'google/gemini-flash-3',
  systemPromptPath: 'prompts/05-jarvis.txt',
  tools: [],
  namespace: '05_JARVIS',
  tokenBudget: 100000
});

// ── HA helpers ──────────────────────────────────────────────────────────────

function haHeaders() {
  return { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' };
}

// Map friendly device names to HA entity IDs
const DEVICE_MAP = {
  ac:             { domain: 'climate',    entityId: process.env.HA_AC_ENTITY || 'climate.living_room_ac' },
  bedroom_lights: { domain: 'light',      entityId: process.env.HA_BEDROOM_LIGHTS || 'light.bedroom' },
  desk_lamp:      { domain: 'light',      entityId: process.env.HA_DESK_LAMP || 'light.desk_lamp' }
};

async function controlHome(device, action, value) {
  try {
    const d = DEVICE_MAP[device];
    if (!d) return `Unknown device: ${device}`;
    let service, payload;
    if (d.domain === 'climate') {
      if (action === 'set_temperature') {
        service = 'set_temperature';
        payload = { entity_id: d.entityId, temperature: value };
      } else if (action === 'turn_off') {
        service = 'turn_off';
        payload = { entity_id: d.entityId };
      } else {
        service = action;
        payload = { entity_id: d.entityId, ...(value !== undefined ? { temperature: value } : {}) };
      }
    } else {
      if (action === 'dim') {
        service = 'turn_on';
        payload = { entity_id: d.entityId, brightness_pct: Number(value) };
      } else {
        service = action;
        payload = { entity_id: d.entityId };
      }
    }
    await axios.post(`${HA_URL}/api/services/${d.domain}/${service}`, payload, { headers: haHeaders() });
    return `OK: ${device} → ${action}${value !== undefined ? ` (${value})` : ''}`;
  } catch (e) {
    return `controlHome error [${device}/${action}]: ${e.message}`;
  }
}

async function readSensors() {
  try {
    const res = await axios.get(`${HA_URL}/api/states`, { headers: haHeaders() });
    const states = res.data;
    const relevant = {};
    const ENTITIES = [
      process.env.HA_MOTION_SENSOR || 'binary_sensor.aqara_motion_p1',
      process.env.HA_TEMP_SENSOR   || 'sensor.tapo_t310_temperature',
      process.env.HA_DOOR_SENSOR   || 'binary_sensor.door_sensor'
    ];
    for (const s of states) {
      if (ENTITIES.includes(s.entity_id)) {
        relevant[s.entity_id] = { state: s.state, last_changed: s.last_changed };
      }
    }
    return relevant;
  } catch (e) {
    console.error('[05-jarvis] readSensors error:', e.message);
    return {};
  }
}

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[05-jarvis] Slack post error:', e.message);
  }
}

// ── Automation logic ─────────────────────────────────────────────────────────

let lastMotionTs = Date.now(); // conservative init

async function checkAutomations() {
  try {
    const hour = new Date().getHours();
    const sensors = await readSensors();

    // Track last motion
    const motionEntity = process.env.HA_MOTION_SENSOR || 'binary_sensor.aqara_motion_p1';
    if (sensors[motionEntity]?.state === 'on') {
      lastMotionTs = Date.now();
    }

    const noMotionMs = Date.now() - lastMotionTs;
    const noMotionHours = noMotionMs / 3600000;

    // Rule 1: No motion for 2+ hours during 9AM-6PM → turn off AC + dim lights to 10%
    if (hour >= 9 && hour < 18 && noMotionHours >= 2) {
      await controlHome('ac', 'turn_off', undefined);
      await controlHome('bedroom_lights', 'dim', 10);
      await controlHome('desk_lamp', 'dim', 10);
      await postSlack(`Auto: no motion for ${Math.floor(noMotionHours)}h — AC off, lights dimmed to 10%.`);
    }

    // Rule 2: Door closed after 10:30PM → sleep mode
    const doorEntity = process.env.HA_DOOR_SENSOR || 'binary_sensor.door_sensor';
    const doorClosed = sensors[doorEntity]?.state === 'off';
    if (hour >= 22 || hour < 1) {
      if (doorClosed) {
        await controlHome('bedroom_lights', 'dim', 10);
        await controlHome('desk_lamp', 'dim', 10);
        await controlHome('ac', 'set_temperature', 22);
        await postSlack(`Sleep mode activated: lights 10%, AC 22°C.`);
      }
    }
  } catch (e) {
    console.error('[05-jarvis] automation error:', e.message);
  }
}

// ── Slack command handler ─────────────────────────────────────────────────────
// The Slack gateway (99-slack-gateway.js) forwards messages; here we also support
// stand-alone command polling via SLACK REST API (fallback).

export async function handleSlackCommand(text) {
  const lower = text.toLowerCase();
  // e.g. "turn off ac", "dim bedroom lights to 30", "sleep mode"
  if (lower.includes('sleep mode')) {
    await controlHome('bedroom_lights', 'dim', 10);
    await controlHome('desk_lamp', 'dim', 10);
    await controlHome('ac', 'set_temperature', 22);
    return 'Sleep mode activated.';
  }
  if (lower.includes('turn off ac') || lower.includes('ac off')) {
    return await controlHome('ac', 'turn_off', undefined);
  }
  if (lower.includes('sensors')) {
    const s = await readSensors();
    return JSON.stringify(s, null, 2);
  }
  // AI-interpreted command
  const ctx = `Available devices: ${Object.keys(DEVICE_MAP).join(', ')}. Current sensors: ${JSON.stringify(await readSensors())}`;
  const reply = await jarvis.run(`Execute home command: "${text}"`, ctx);
  return reply;
}

// Every 30 minutes
cron.schedule('*/30 * * * *', async () => { await checkAutomations(); });

if (process.argv.includes('--check-now')) {
  checkAutomations();
}
