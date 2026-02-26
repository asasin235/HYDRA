/**
 * core/hermes-bridge.js — HYDRA ↔ Hermes Agent integration bridge
 *
 * Hermes Agent is the unified messaging gateway for HYDRA:
 *   - WhatsApp (native Baileys bridge)
 *   - Telegram
 *   - Discord
 *   - Slack
 *
 * This module provides a unified API for HYDRA agents to:
 *   - Send messages through Hermes via the hermes CLI
 *   - Read messages using Hermes session data
 *   - Manage procedural skills
 *
 * OpenClaw is now retained ONLY for MCP tools and LanceDB memory.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { rootLogger } from './logger.js';
import path from 'path';
import fs from 'fs-extra';

const execFileAsync = promisify(execFile);
const log = rootLogger.child({ module: 'hermes-bridge' });

const HERMES_BIN = process.env.HERMES_BIN || '/Users/hydra/.local/bin/hermes';
const HERMES_HOME = process.env.HERMES_HOME || '/Users/hydra/.hermes';
const HERMES_TIMEOUT = Number(process.env.HERMES_TIMEOUT || 20000);

// ── CLI runner ────────────────────────────────────────────────────────────────

/**
 * Run a Hermes CLI command
 * @param {string[]} args
 * @param {number} [timeout]
 * @returns {Promise<{ok: boolean, stdout?: string, error?: string}>}
 */
async function runHermes(args, timeout = HERMES_TIMEOUT) {
    try {
        const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
            timeout,
            maxBuffer: 2 * 1024 * 1024, // 2MB
            env: { ...process.env }
        });
        return { ok: true, stdout: stdout.trim() };
    } catch (e) {
        const errMsg = e.stderr?.trim() || e.message || 'unknown error';
        log.error('Hermes CLI error', { cmd: `hermes ${args.slice(0, 3).join(' ')}`, error: errMsg });
        return { ok: false, error: errMsg };
    }
}

// ── Gateway status ──────────────────────────────────────────────────────────

/**
 * Check if the Hermes gateway is running
 * @returns {Promise<{online: boolean, error?: string}>}
 */
export async function getGatewayStatus() {
    const result = await runHermes(['gateway', 'status'], 5000);
    return { online: result.ok && !result.stdout?.toLowerCase().includes('not running') };
}

// ── Messaging ─────────────────────────────────────────────────────────────────

/**
 * Send a message via Hermes gateway
 * @param {'whatsapp'|'telegram'|'discord'|'slack'} channel
 * @param {string} target - phone (E.164) / username / channel
 * @param {string} message
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendMessage(channel, target, message) {
    // Hermes uses `hermes agent --deliver --to <target> --message <msg>` for direct sends
    // For platform-specific sends, we use the message CLI
    const args = ['message', 'send', '--channel', channel, '--target', target, '--message', message, '--json'];
    const result = await runHermes(args);
    if (!result.ok) return { success: false, error: result.error };
    return { success: true };
}

/** Send a WhatsApp message via Hermes */
export async function sendWhatsApp(to, message) {
    return sendMessage('whatsapp', to, message);
}

/** Send a Telegram message via Hermes */
export async function sendTelegram(to, message) {
    return sendMessage('telegram', to, message);
}

/** Send a Discord message via Hermes */
export async function sendDiscord(to, message) {
    return sendMessage('discord', to, message);
}

// ── Read messages from Hermes sessions ─────────────────────────────────────

/**
 * Read recent sessions from Hermes SQLite state db
 * Returns an array of recent messages for a given platform tag
 * @param {'whatsapp'|'telegram'|'discord'|'slack'} channel
 * @param {string} contact
 * @param {number} [limit=10]
 * @returns {Promise<Array<{from: string, text: string, timestamp: string}>>}
 */
export async function getMessages(channel, contact, limit = 10) {
    // Hermes stores sessions in ~/.hermes/state.db (SQLite with FTS5)
    // We query via `hermes sessions list --json --source <channel>` 
    const args = ['sessions', 'list', '--json', '--source', channel, '--limit', String(limit)];
    const result = await runHermes(args, 10000);
    if (!result.ok) {
        log.warn('getMessages failed', { channel, contact, error: result.error });
        return [];
    }
    try {
        const sessions = JSON.parse(result.stdout);
        // Filter by contact if possible, flatten to message-like objects
        return (sessions || [])
            .filter(s => !contact || s.recipient?.includes(contact) || s.title?.includes(contact))
            .slice(0, limit)
            .map(s => ({
                from: s.recipient || 'unknown',
                text: s.last_message || s.summary || '',
                timestamp: s.updated_at || s.created_at || new Date().toISOString()
            }));
    } catch {
        return [];
    }
}

// ── Skills management ─────────────────────────────────────────────────────────

/**
 * List all available Hermes skills
 * @returns {Promise<string[]>}
 */
export async function listSkills() {
    const skillsDir = path.join(HERMES_HOME, 'skills');
    try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
        return [];
    }
}

/**
 * Create or update a skill in ~/.hermes/skills/
 * @param {string} skillName - kebab-case skill name
 * @param {string} skillContent - SKILL.md content
 * @returns {Promise<boolean>}
 */
export async function writeSkill(skillName, skillContent) {
    const skillDir = path.join(HERMES_HOME, 'skills', skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');
    try {
        await fs.ensureDir(skillDir);
        await fs.writeFile(skillPath, skillContent, 'utf-8');
        log.info(`Skill written: ${skillName}`);
        return true;
    } catch (e) {
        log.error('writeSkill error', { skillName, error: e.message });
        return false;
    }
}

/**
 * Read a skill's SKILL.md
 * @param {string} skillName
 * @returns {Promise<string|null>}
 */
export async function readSkill(skillName) {
    const skillPath = path.join(HERMES_HOME, 'skills', skillName, 'SKILL.md');
    try {
        return await fs.readFile(skillPath, 'utf-8');
    } catch {
        return null;
    }
}
