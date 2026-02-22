/**
 * core/openclaw-memory.js — OpenClaw Memory bridge for HYDRA agents
 *
 * All-in-one interface for reading/writing to OpenClaw's memory system.
 * Data is stored as Markdown files in the shared context directory,
 * auto-indexed by OpenClaw's vector search (BM25 + embeddings).
 *
 * Usage:
 *   import { writeContext, searchContext, writeScreenActivity } from '../core/openclaw-memory.js';
 *   await writeScreenActivity('macbook-pro', 'Working in Cursor on HYDRA...', ['Cursor', 'Chrome']);
 *   const results = await searchContext('what was I working on yesterday?');
 */
import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BRAIN_PATH = process.env.BRAIN_PATH || '~/hydra-brain';
const SHARED_CTX_DIR = path.join(BRAIN_PATH.replace(/^~/, process.env.HOME), 'shared_context');
const SCREEN_DIR = path.join(SHARED_CTX_DIR, 'screen');
const AUDIO_DIR = path.join(SHARED_CTX_DIR, 'audio');
const NOTES_DIR = path.join(SHARED_CTX_DIR, 'notes');

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT || 15000);

/**
 * Ensure shared context directories exist
 */
async function ensureDirs() {
    await fs.ensureDir(SCREEN_DIR);
    await fs.ensureDir(AUDIO_DIR);
    await fs.ensureDir(NOTES_DIR);
}

/**
 * Get today's date string (YYYY-MM-DD)
 */
function today() {
    return new Date().toISOString().split('T')[0];
}

/**
 * Get current time string (HH:MM)
 */
function timeNow() {
    return new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: process.env.TZ || 'Asia/Kolkata'
    });
}

// ── Write Functions ───────────────────────────────────────────────────────────

/**
 * Append a screen activity summary to today's screen log.
 * Written as Markdown, auto-indexed by OpenClaw.
 *
 * @param {string} source - Device name (e.g., 'macbook-pro', 'mac-mini')
 * @param {string} summary - Activity summary text
 * @param {string[]} apps - List of active apps
 */
export async function writeScreenActivity(source, summary, apps = []) {
    await ensureDirs();
    const file = path.join(SCREEN_DIR, `${today()}.md`);
    const appList = apps.length > 0 ? ` | Apps: ${apps.join(', ')}` : '';
    const entry = `\n## ${timeNow()} — ${source}${appList}\n\n${summary}\n`;

    await fs.appendFile(file, entry, 'utf-8');
    console.log(`[openclaw-memory] Screen activity written → ${file}`);
}

/**
 * Append an audio transcript to today's audio log.
 *
 * @param {string} source - Source device/app (e.g., 'plaud-note', 'voice-memo')
 * @param {string} filename - Original audio filename
 * @param {string} transcript - Full transcript text
 * @param {string} summary - LLM-generated summary
 * @param {number} [durationS] - Duration in seconds
 */
export async function writeAudioTranscript(source, filename, transcript, summary, durationS) {
    await ensureDirs();
    const file = path.join(AUDIO_DIR, `${today()}.md`);
    const duration = durationS ? ` (${Math.round(durationS / 60)}min)` : '';
    const entry = `\n## ${timeNow()} — ${source}: ${filename}${duration}\n\n**Summary:** ${summary}\n\n<details>\n<summary>Full transcript</summary>\n\n${transcript}\n\n</details>\n`;

    await fs.appendFile(file, entry, 'utf-8');
    console.log(`[openclaw-memory] Audio transcript written → ${file}`);
}

/**
 * Write a general context note.
 *
 * @param {string} source - Source agent or system
 * @param {string} type - Entry type (e.g., 'observation', 'decision', 'reminder')
 * @param {string} content - Content text
 */
export async function writeContext(source, type, content) {
    await ensureDirs();
    const file = path.join(NOTES_DIR, `${today()}.md`);
    const entry = `\n## ${timeNow()} — ${source} [${type}]\n\n${content}\n`;

    await fs.appendFile(file, entry, 'utf-8');
}

// ── Search Functions ──────────────────────────────────────────────────────────

/**
 * Search OpenClaw's memory using the CLI.
 *
 * @param {string} query - Natural language search query
 * @param {number} [limit=5] - Max results
 * @returns {Promise<Array<{path: string, snippet: string, score?: number}>>}
 */
export async function searchContext(query, limit = 5) {
    try {
        const { stdout } = await execFileAsync(OPENCLAW_BIN, [
            'memory', 'search', '--query', query, '--limit', String(limit), '--json'
        ], { timeout: OPENCLAW_TIMEOUT, env: { ...process.env } });

        const trimmed = stdout.trim();
        if (!trimmed) return [];

        try {
            const data = JSON.parse(trimmed);
            return Array.isArray(data) ? data : (data.results || []);
        } catch {
            return [{ path: 'raw', snippet: trimmed }];
        }
    } catch (e) {
        console.error('[openclaw-memory] search failed:', e.stderr?.trim() || e.message);
        return [];
    }
}

// ── Read Functions ────────────────────────────────────────────────────────────

/**
 * Read today's screen activity log.
 * @returns {Promise<string>} Markdown content or empty string
 */
export async function readTodayScreenActivity() {
    const file = path.join(SCREEN_DIR, `${today()}.md`);
    try {
        return await fs.readFile(file, 'utf-8');
    } catch {
        return '';
    }
}

/**
 * Read today's audio transcripts.
 * @returns {Promise<string>} Markdown content or empty string
 */
export async function readTodayAudioTranscripts() {
    const file = path.join(AUDIO_DIR, `${today()}.md`);
    try {
        return await fs.readFile(file, 'utf-8');
    } catch {
        return '';
    }
}

/**
 * Read recent context files (last N days).
 * @param {string} subdir - 'screen', 'audio', or 'notes'
 * @param {number} [days=3] - How many days back to read
 * @returns {Promise<string>} Combined Markdown content
 */
export async function readRecentContext(subdir, days = 3) {
    const dir = path.join(SHARED_CTX_DIR, subdir);
    try {
        const files = (await fs.readdir(dir))
            .filter(f => f.endsWith('.md'))
            .sort()
            .slice(-days);

        const contents = [];
        for (const f of files) {
            const content = await fs.readFile(path.join(dir, f), 'utf-8');
            contents.push(`# ${f.replace('.md', '')}\n${content}`);
        }
        return contents.join('\n\n---\n\n');
    } catch {
        return '';
    }
}

// ── Setup Helper ──────────────────────────────────────────────────────────────

/**
 * Configure OpenClaw to index the shared context directory.
 * Run once during setup.
 */
export async function setupOpenClawMemoryPaths() {
    try {
        const { stdout } = await execFileAsync(OPENCLAW_BIN, [
            'config', 'set', 'agents.defaults.memorySearch.extraPaths',
            JSON.stringify([SHARED_CTX_DIR])
        ], { timeout: OPENCLAW_TIMEOUT, env: { ...process.env } });
        console.log('[openclaw-memory] Configured extraPaths:', SHARED_CTX_DIR);
        return { success: true };
    } catch (e) {
        console.error('[openclaw-memory] Failed to set extraPaths:', e.message);
        return { success: false, error: e.message };
    }
}
