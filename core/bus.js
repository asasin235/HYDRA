/**
 * core/bus.js — Redis pub/sub event bus for inter-agent communication.
 *
 * Usage:
 *   import { publish, subscribe } from '../core/bus.js';
 *   subscribe('health.alert', (payload) => { ... });
 *   publish('health.alert', { agent: '07-biobot', type: 'low_hrv', value: 35 });
 *
 * Channel conventions:
 *   hydra:agent.run       — Every completed agent run
 *   hydra:agent.error     — Every failed agent run
 *   hydra:health.alert    — Health signals from biobot
 *   hydra:budget.warning  — Budget threshold warnings
 *   hydra:market.signal   — Trading signals from wolf
 *
 * All errors are non-fatal — if Redis is down, agents continue normally.
 */
import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { insertTraceHeaders, acceptTraceHeaders, newrelic } from './nr-instrument.js';

const log = createLogger('bus');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Two connections: ioredis requires a separate connection for subscribe mode
let pub = null;
let sub = null;
const handlers = new Map(); // channel → Set<callback>

function ensurePub() {
  if (pub) return pub;
  pub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  pub.on('error', (e) => log.warn('Redis pub error', { error: e.message }));
  pub.connect().catch(() => {});
  return pub;
}

function ensureSub() {
  if (sub) return sub;
  sub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  sub.on('error', (e) => log.warn('Redis sub error', { error: e.message }));
  sub.on('message', (channel, message) => {
    const callbacks = handlers.get(channel);
    if (!callbacks) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      payload = { raw: message };
    }

    // Extract and strip distributed trace headers before passing to callbacks
    const traceHeaders = payload._traceHeaders || null;
    const cleanPayload = { ...payload };
    delete cleanPayload._traceHeaders;

    for (const cb of callbacks) {
      // Wrap each callback in a NR background transaction linked to the upstream trace
      const invoke = async () => {
        try {
          await cb(cleanPayload);
        } catch (e) {
          log.error('Bus handler error', { channel, error: e.message });
        }
      };
      if (newrelic) {
        const shortChannel = channel.replace('hydra:', '');
        newrelic.startBackgroundTransaction(`HYDRA/bus/${shortChannel}`, 'Bus', async () => {
          acceptTraceHeaders(traceHeaders);
          await invoke();
        });
      } else {
        invoke().catch(() => {});
      }
    }
  });
  sub.connect().catch(() => {});
  return sub;
}

/**
 * Publish an event to a channel.
 * @param {string} channel - e.g., 'health.alert', 'budget.warning', 'agent.run'
 * @param {object} payload - JSON-serializable data
 */
export async function publish(channel, payload) {
  try {
    const client = ensurePub();
    const _traceHeaders = insertTraceHeaders();
    const message = JSON.stringify({ ...payload, _ts: Date.now(), _traceHeaders });
    await client.publish(`hydra:${channel}`, message);
  } catch (e) {
    log.warn('Bus publish failed (non-fatal)', { channel, error: e.message });
  }
}

/**
 * Subscribe to events on a channel.
 * @param {string} channel - e.g., 'health.alert'
 * @param {function} callback - Called with parsed payload object
 */
export async function subscribe(channel, callback) {
  try {
    const client = ensureSub();
    const fullChannel = `hydra:${channel}`;
    if (!handlers.has(fullChannel)) {
      handlers.set(fullChannel, new Set());
      await client.subscribe(fullChannel);
    }
    handlers.get(fullChannel).add(callback);
  } catch (e) {
    log.warn('Bus subscribe failed (non-fatal)', { channel, error: e.message });
  }
}

/**
 * Gracefully close Redis connections.
 */
export async function closeBus() {
  if (pub) { pub.disconnect(); pub = null; }
  if (sub) { sub.disconnect(); sub = null; }
}
