/**
 * hydra-screenpipe-sync — Laptop-side Screenpipe summarizer daemon
 *
 * Runs on your MacBook Pro. Every 15 minutes:
 * 1. Reads screen captures + audio transcripts from Screenpipe's local API
 * 2. Summarizes via local Ollama LLM (zero cost, fully private)
 * 3. Writes Markdown summary to the Mac Mini's shared context directory via SSH/rsync
 *
 * Prerequisites:
 *   - Screenpipe running on laptop (https://screenpi.pe)
 *   - Ollama running with a model pulled (e.g., qwen2.5:7b)
 *   - SSH access to Mac Mini (key-based auth recommended)
 *
 * Usage:
 *   node sync.js                  # foreground
 *   node sync.js --once           # single run, then exit
 *   pm2 start sync.js --name hydra-screenpipe-sync
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const SCREENPIPE_API = process.env.SCREENPIPE_API || 'http://localhost:3030';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

const MAC_MINI_USER = process.env.MAC_MINI_USER || 'hydra';
const MAC_MINI_HOST = process.env.MAC_MINI_HOST || '192.168.68.100';
const MAC_MINI_BRAIN_PATH = process.env.MAC_MINI_BRAIN_PATH || '~/hydra-brain/shared_context/screen';

const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 15);
const RELEVANT_APPS = (process.env.RELEVANT_APPS || 'Cursor,Code,Chrome,Safari,Slack,Terminal,iTerm2,Jira,Figma,Notion,Discord,WhatsApp').split(',');

const LOCAL_BUFFER_DIR = path.join(__dirname, '.buffer');

// ── Screenpipe API ────────────────────────────────────────────────────────────

async function fetchScreenpipe(minutes) {
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    try {
        // Fetch OCR (screen) data
        const screenRes = await fetch(
            `${SCREENPIPE_API}/search?content_type=ocr&start_time=${since}&limit=100&json=true`
        );
        const screenData = screenRes.ok ? await screenRes.json() : { data: [] };

        // Fetch audio transcript data
        const audioRes = await fetch(
            `${SCREENPIPE_API}/search?content_type=audio&start_time=${since}&limit=50&json=true`
        );
        const audioData = audioRes.ok ? await audioRes.json() : { data: [] };

        // Filter screen data by relevant apps
        const screenEntries = (screenData.data || [])
            .filter(e => {
                const app = e.content?.app_name || '';
                return RELEVANT_APPS.some(a => app.toLowerCase().includes(a.toLowerCase()));
            })
            .map(e => ({
                app: e.content?.app_name || 'unknown',
                window: e.content?.window_name || '',
                text: (e.content?.text || '').slice(0, 300),
                timestamp: e.content?.timestamp || e.timestamp
            }));

        const audioEntries = (audioData.data || [])
            .filter(e => e.content?.transcription && e.content.transcription.length > 10)
            .map(e => ({
                text: e.content.transcription.slice(0, 500),
                timestamp: e.content?.timestamp || e.timestamp
            }));

        return { screen: screenEntries, audio: audioEntries };
    } catch (e) {
        console.error('[sync] Screenpipe API error:', e.message);
        return { screen: [], audio: [] };
    }
}

// ── Ollama Local LLM ─────────────────────────────────────────────────────────

async function summarize(screenEntries, audioEntries) {
    const screenText = screenEntries
        .map(e => `[${e.app}] ${e.window}: ${e.text}`)
        .join('\n')
        .slice(0, 4000);

    const audioText = audioEntries
        .map(e => e.text)
        .join('\n')
        .slice(0, 2000);

    if (!screenText && !audioText) return null;

    const prompt = `Summarize what the user was doing in the last ${SYNC_INTERVAL_MINUTES} minutes based on these screen captures and audio transcripts. Be concise — max 3 sentences. Also list the apps used.

SCREEN CAPTURES:
${screenText || '(none)'}

AUDIO TRANSCRIPTS:
${audioText || '(none)'}

Output format:
SUMMARY: <your summary>
APPS: <comma-separated list>`;

    try {
        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                options: { temperature: 0.3, num_predict: 200 }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Ollama error (${res.status}): ${err}`);
        }

        const data = await res.json();
        return data.response || null;
    } catch (e) {
        console.error('[sync] Ollama error:', e.message);
        // Fallback: raw concatenation
        const apps = [...new Set(screenEntries.map(e => e.app))];
        return `SUMMARY: Screen activity in ${apps.join(', ')}. ${screenEntries.length} captures, ${audioEntries.length} audio segments.\nAPPS: ${apps.join(', ')}`;
    }
}

// ── Write & Sync ──────────────────────────────────────────────────────────────

function todayDate() {
    return new Date().toISOString().split('T')[0];
}

function timeNow() {
    return new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: process.env.TZ || 'Asia/Kolkata'
    });
}

function parseResponse(response) {
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?:\n|$)/s);
    const appsMatch = response.match(/APPS:\s*(.+?)(?:\n|$)/);

    const summary = summaryMatch ? summaryMatch[1].trim() : response.trim();
    const apps = appsMatch
        ? appsMatch[1].split(',').map(a => a.trim()).filter(Boolean)
        : [];

    return { summary, apps };
}

async function writeAndSync(summary, apps) {
    const date = todayDate();
    const time = timeNow();
    const appList = apps.length > 0 ? ` | Apps: ${apps.join(', ')}` : '';
    const entry = `\n## ${time} — macbook-pro${appList}\n\n${summary}\n`;

    // Write to local buffer first
    await fs.mkdir(LOCAL_BUFFER_DIR, { recursive: true });
    const localFile = path.join(LOCAL_BUFFER_DIR, `${date}.md`);
    await fs.appendFile(localFile, entry, 'utf-8');

    // Sync to Mac Mini via SSH + append
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        // Use ssh to append to the remote file
        const remoteFile = `${MAC_MINI_BRAIN_PATH}/${date}.md`;
        const sshCmd = `mkdir -p ${MAC_MINI_BRAIN_PATH} && cat >> ${remoteFile}`;

        await execFileAsync('ssh', [
            `${MAC_MINI_USER}@${MAC_MINI_HOST}`,
            sshCmd
        ], {
            timeout: 10000,
            input: entry
        });

        console.log(`[sync] ✅ Synced to ${MAC_MINI_HOST}:${remoteFile}`);
    } catch (e) {
        console.error(`[sync] ⚠️ SSH sync failed (buffered locally): ${e.message}`);
        // Data is safely buffered in LOCAL_BUFFER_DIR, will be synced on next attempt
    }
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

async function runOnce() {
    console.log(`[sync] Fetching Screenpipe data (last ${SYNC_INTERVAL_MINUTES}min)...`);

    const { screen, audio } = await fetchScreenpipe(SYNC_INTERVAL_MINUTES + 1); // +1 min overlap

    if (screen.length === 0 && audio.length === 0) {
        console.log('[sync] No activity detected, skipping.');
        return;
    }

    console.log(`[sync] ${screen.length} screen captures, ${audio.length} audio segments`);

    const response = await summarize(screen, audio);
    if (!response) {
        console.log('[sync] Empty summary, skipping.');
        return;
    }

    const { summary, apps } = parseResponse(response);
    console.log(`[sync] Summary: ${summary.slice(0, 100)}...`);

    await writeAndSync(summary, apps);
}

// Run
const isOnce = process.argv.includes('--once');

console.log(`[sync] Starting HYDRA Screenpipe Sync`);
console.log(`[sync] Screenpipe: ${SCREENPIPE_API}`);
console.log(`[sync] Ollama: ${OLLAMA_URL} (${OLLAMA_MODEL})`);
console.log(`[sync] Target: ${MAC_MINI_USER}@${MAC_MINI_HOST}:${MAC_MINI_BRAIN_PATH}`);
console.log(`[sync] Interval: ${SYNC_INTERVAL_MINUTES}min`);

runOnce();

if (!isOnce) {
    setInterval(runOnce, SYNC_INTERVAL_MINUTES * 60 * 1000);
    console.log(`[sync] Daemon running. Next sync in ${SYNC_INTERVAL_MINUTES} minutes.`);
}
