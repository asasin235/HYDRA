/**
 * core/openclaw.js — Shared OpenClaw Gateway client
 * Uses the OpenClaw CLI (`openclaw message send`, etc.) to communicate
 * with the running OpenClaw gateway daemon.
 *
 * Usage:
 *   import { sendMessage, sendWhatsApp, sendDiscord } from '../core/openclaw.js';
 *   await sendWhatsApp('+919876543210', 'goodnight ❤️');
 *   await sendMessage('discord', '#general', 'deploy complete');
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT || 15000);

/**
 * Run an OpenClaw CLI command and return parsed JSON output.
 * @param {string[]} args - CLI arguments
 * @param {number} [timeout] - Override timeout in ms
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function runCli(args, timeout = OPENCLAW_TIMEOUT) {
  try {
    const { stdout, stderr } = await execFileAsync(OPENCLAW_BIN, [...args, '--json'], {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env }
    });

    // Try to parse JSON from stdout
    const trimmed = stdout.trim();
    if (!trimmed) return { ok: true, data: {} };

    try {
      const data = JSON.parse(trimmed);
      return { ok: true, data };
    } catch {
      // CLI returned non-JSON output — treat as raw text
      return { ok: true, data: { raw: trimmed } };
    }
  } catch (e) {
    // execFile error: timeout, exit code !== 0, or binary not found
    const errMsg = e.stderr?.trim() || e.message;
    console.error(`[openclaw] CLI error (${args.slice(0, 3).join(' ')}):`, errMsg);
    return { ok: false, error: errMsg };
  }
}

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
    return { success: false, error: result.error };
  }
  return {
    success: true,
    messageId: result.data?.id || result.data?.messageId || undefined
  };
}

/**
 * Send a WhatsApp message.
 */
export async function sendWhatsApp(to, message, options = {}) {
  return sendMessage('whatsapp', to, message, options);
}

/**
 * Send an iMessage.
 */
export async function sendIMessage(to, message, options = {}) {
  return sendMessage('imessage', to, message, options);
}

/**
 * Send a Discord message.
 */
export async function sendDiscord(to, message, options = {}) {
  return sendMessage('discord', to, message, options);
}

/**
 * Send a Telegram message.
 */
export async function sendTelegram(to, message, options = {}) {
  return sendMessage('telegram', to, message, options);
}

/**
 * Check if OpenClaw Gateway is reachable and healthy.
 * @returns {Promise<{online: boolean, channels?: object, version?: string, error?: string}>}
 */
export async function getGatewayStatus() {
  const result = await runCli(['health'], 5000);
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
  const result = await runCli(['channels', 'status'], 5000);
  if (!result.ok) {
    return { online: false, error: result.error };
  }
  return {
    online: true,
    channels: result.data?.channels || result.data
  };
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
    console.error(`[openclaw] getMessages failed:`, result.error);
    return [];
  }
  return result.data?.messages || (Array.isArray(result.data) ? result.data : []);
}
