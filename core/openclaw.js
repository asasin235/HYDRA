/**
 * core/openclaw.js — OpenClaw Gateway client (DEPRECATED for messaging)
 *
 * ⚠️  MESSAGING IS NOW HANDLED BY HERMES AGENT (core/hermes-bridge.js)
 *     sendMessage, sendWhatsApp, sendTelegram, sendDiscord, getMessages
 *     all redirect to hermes-bridge.js.
 *
 * OpenClaw is retained ONLY for:
 *   - Gateway health checks (getGatewayStatus, isGatewayAvailable)
 *   - Channel status checks (getChannelStatus)
 *   - MCP tool connectivity
 *   - LanceDB / openclaw-memory integration
 *
 * Do NOT add new messaging calls here.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { rootLogger } from './logger.js';

const execFileAsync = promisify(execFile);

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT || 15000);

const log = rootLogger.child({ module: 'openclaw' });

// ── Gateway availability cache ────────────────────────────────────────────────
// Caches the result of `openclaw health` for 60s to avoid hammering the CLI
// on every send() call when the gateway is known to be up.
let _gatewayCache = null;      // { online: boolean, checkedAt: number }
const GATEWAY_CACHE_TTL = 60 * 1000; // 60 seconds

/** @returns {boolean} True if the cached result is still fresh */
function isCacheValid() {
  return _gatewayCache !== null && (Date.now() - _gatewayCache.checkedAt) < GATEWAY_CACHE_TTL;
}

/** Invalidate the gateway cache (call after any send failure). */
function invalidateGatewayCache() {
  _gatewayCache = null;
}

// ── CLI runner ────────────────────────────────────────────────────────────────

/**
 * Run an OpenClaw CLI command and return parsed JSON output.
 * Retries once on transient failures (timeout, non-zero exit from a server error).
 *
 * @param {string[]} args - CLI arguments (--json is appended automatically)
 * @param {number} [timeout] - Override timeout in ms
 * @param {number} [maxAttempts=2] - Max retry attempts
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function runCli(args, timeout = OPENCLAW_TIMEOUT, maxAttempts = 2) {
  const fullArgs = [...args, '--json'];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(OPENCLAW_BIN, fullArgs, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env }
      });

      const trimmed = stdout.trim();
      if (!trimmed) return { ok: true, data: {} };

      try {
        const data = JSON.parse(trimmed);
        return { ok: true, data };
      } catch {
        // CLI returned non-JSON — treat as raw text
        return { ok: true, data: { raw: trimmed } };
      }
    } catch (e) {
      lastError = e;
      const isTransient = e.killed || e.code === 'ETIMEDOUT' || (e.stderr || '').includes('5');
      if (attempt < maxAttempts && isTransient) {
        log.warn(`OpenClaw CLI transient failure, retrying (attempt ${attempt}/${maxAttempts})`, {
          cmd: `${OPENCLAW_BIN} ${args.slice(0, 3).join(' ')}`,
          error: e.message
        });
        await new Promise(r => setTimeout(r, 500 * attempt)); // 500ms, 1s
        continue;
      }
      break;
    }
  }

  const errMsg = lastError?.stderr?.trim() || lastError?.message || 'unknown error';
  log.error(`OpenClaw CLI error`, {
    cmd: `${OPENCLAW_BIN} ${args.join(' ')}`,
    error: errMsg
  });
  return { ok: false, error: errMsg };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a message through OpenClaw Gateway.
 * @param {string} channel - 'whatsapp' | 'imessage' | 'discord' | 'telegram' | etc.
 * @param {string} to - Contact phone (E.164), chat ID, or channel target
 * @param {string} message - Message text to send
 * @param {object} [options] - Optional: { replyTo, media, silent, dryRun }
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendMessage(channel, to, message, options = {}) {
  const args = ['message', 'send', '--channel', channel, '--target', to, '--message', message];

  if (options.replyTo) args.push('--reply-to', options.replyTo);
  if (options.media) args.push('--media', options.media);
  if (options.silent) args.push('--silent');
  if (options.dryRun) args.push('--dry-run');

  const result = await runCli(args);
  if (!result.ok) {
    // Invalidate gateway cache on send failure — it may be down
    invalidateGatewayCache();
    return { success: false, error: result.error };
  }
  return {
    success: true,
    messageId: result.data?.id || result.data?.messageId || undefined
  };
}

/** Send a WhatsApp message. */
export async function sendWhatsApp(to, message, options = {}) {
  return sendMessage('whatsapp', to, message, options);
}

/** Send an iMessage. */
export async function sendIMessage(to, message, options = {}) {
  return sendMessage('imessage', to, message, options);
}

/** Send a Discord message. */
export async function sendDiscord(to, message, options = {}) {
  return sendMessage('discord', to, message, options);
}

/** Send a Telegram message. */
export async function sendTelegram(to, message, options = {}) {
  return sendMessage('telegram', to, message, options);
}

/**
 * Check if OpenClaw Gateway is reachable and healthy.
 * Result is cached for 60s to avoid repeated CLI calls.
 * @param {boolean} [forceRefresh=false] - Bypass cache
 * @returns {Promise<{online: boolean, channels?: object, version?: string, error?: string}>}
 */
export async function getGatewayStatus(forceRefresh = false) {
  if (!forceRefresh && isCacheValid()) {
    return { online: _gatewayCache.online };
  }

  const result = await runCli(['health'], 5000, 1); // no retry on health checks
  const online = result.ok && !!result.data;
  _gatewayCache = { online, checkedAt: Date.now() };

  if (!result.ok) {
    return { online: false, error: result.error };
  }
  return {
    online: true,
    channels: result.data?.channels || result.data,
    version: result.data?.version
  };
}

/**
 * Get channel connection status from the gateway.
 * @returns {Promise<{online: boolean, channels?: object[], error?: string}>}
 */
export async function getChannelStatus() {
  const result = await runCli(['channels', 'status'], 5000, 1);
  if (!result.ok) {
    return { online: false, error: result.error };
  }
  return {
    online: true,
    channels: result.data?.channels || result.data
  };
}

/**
 * Check if the gateway binary is installed and accessible.
 * Uses cached result from getGatewayStatus if available.
 * @returns {Promise<boolean>}
 */
export async function isGatewayAvailable() {
  if (isCacheValid()) return _gatewayCache.online;
  const status = await getGatewayStatus();
  return status.online;
}

/**
 * Get recent messages from a channel/contact.
 * @param {string} channel - 'whatsapp' | 'imessage' | 'discord' | etc.
 * @param {string} contact - Contact phone (E.164) or target
 * @param {number} [limit=10] - Number of recent messages
 * @returns {Promise<Array<{from: string, text: string, timestamp: string}>>}
 */
export async function getMessages(channel, contact, limit = 10) {
  const result = await runCli([
    'message', 'read',
    '--channel', channel,
    '--target', contact,
    '--limit', String(limit)
  ]);

  if (!result.ok) {
    log.error('getMessages failed', { channel, contact, error: result.error });
    return [];
  }
  return result.data?.messages || (Array.isArray(result.data) ? result.data : []);
}
