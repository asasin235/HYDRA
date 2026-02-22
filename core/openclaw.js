/**
 * core/openclaw.js — Shared OpenClaw Gateway client
 * Any HYDRA agent can import this to send messages via WhatsApp, iMessage, Discord, etc.
 *
 * Usage:
 *   import { sendMessage, sendWhatsApp, sendDiscord } from '../core/openclaw.js';
 *   await sendWhatsApp('Sabiha', 'goodnight ❤️');
 *   await sendMessage('discord', '#general', 'deploy complete');
 */
import axios from 'axios';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:3100';
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT || 10000);

const client = axios.create({
  baseURL: OPENCLAW_URL,
  timeout: OPENCLAW_TIMEOUT,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * Send a message through OpenClaw Gateway.
 * @param {string} channel - 'whatsapp' | 'imessage' | 'discord' | 'telegram'
 * @param {string} to - Contact name, phone number, or channel name
 * @param {string} message - Message text to send
 * @param {object} [options] - Optional: { replyTo, media, silent }
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendMessage(channel, to, message, options = {}) {
  try {
    const payload = { channel, to, message, ...options };
    const res = await client.post('/api/send', payload);
    return { success: true, messageId: res.data?.messageId };
  } catch (e) {
    const errMsg = e.response?.data?.error || e.message;
    console.error(`[openclaw] Send failed (${channel} → ${to}):`, errMsg);
    return { success: false, error: errMsg };
  }
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
 * Check if OpenClaw Gateway is reachable.
 * @returns {Promise<{online: boolean, channels?: string[], error?: string}>}
 */
export async function getGatewayStatus() {
  try {
    const res = await client.get('/api/status');
    return {
      online: true,
      channels: res.data?.channels || [],
      version: res.data?.version
    };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

/**
 * Get recent messages from a channel/contact (if OpenClaw supports it).
 * @param {string} channel - 'whatsapp' | 'imessage' | 'discord'
 * @param {string} contact - Contact name or channel
 * @param {number} [limit=10] - Number of recent messages
 * @returns {Promise<Array<{from: string, text: string, timestamp: string}>>}
 */
export async function getMessages(channel, contact, limit = 10) {
  try {
    const res = await client.get('/api/messages', {
      params: { channel, contact, limit }
    });
    return res.data?.messages || [];
  } catch (e) {
    console.error(`[openclaw] getMessages failed:`, e.message);
    return [];
  }
}
