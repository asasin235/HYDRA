/**
 * scripts/plaud-sync.js — Plaud AI → Whisper.cpp → Claude Summarization Pipeline
 *
 * Polls the Plaud REST API every 5 minutes for new completed recordings,
 * transcribes locally via whisper.cpp, summarizes via Claude Sonnet,
 * uploads raw MP3 to Google Drive, and drops output into audio_inbox
 * for ingest-audio.js to pick up.
 *
 * Usage:
 *   node scripts/plaud-sync.js
 *   # or via PM2 in ecosystem.config.cjs
 */
import fs from 'fs-extra';
import path from 'path';
import { google } from 'googleapis';
import { detectTags, wrapWithFrontmatter } from './audio-tagger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const PLAUD_API_KEY = process.env.PLAUD_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_SA_PATH = (process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '')
    .replace(/^~/, process.env.HOME);
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

const BRAIN_PATH = (process.env.BRAIN_PATH || '~/hydra-brain')
    .replace(/^~/, process.env.HOME);
const AUDIO_INBOX = (process.env.AUDIO_INBOX_DIR || '~/hydra-brain/audio_inbox')
    .replace(/^~/, process.env.HOME);
const STATE_DIR = path.join(BRAIN_PATH, 'brain', 'plaud');
const STATE_FILE = path.join(STATE_DIR, 'processed_ids.json');
const TEMP_DIR = path.join(STATE_DIR, 'tmp');

const PLAUD_BASE_URL = 'https://api.plaud.ai';
const POLL_INTERVAL = Number(process.env.PLAUD_POLL_INTERVAL || 300000); // 5 min
const SUMMARY_MODEL = 'google/gemini-2.5-flash';

// ── State Management ──────────────────────────────────────────────────────────

async function loadProcessedIds() {
    try {
        await fs.ensureDir(STATE_DIR);
        if (await fs.pathExists(STATE_FILE)) {
            const data = await fs.readJson(STATE_FILE);
            return new Set(Array.isArray(data) ? data : data.ids || []);
        }
    } catch (e) {
        console.error('[plaud-sync] Failed to load state:', e.message);
    }
    return new Set();
}

async function saveProcessedIds(ids) {
    await fs.ensureDir(STATE_DIR);
    await fs.writeJson(STATE_FILE, { ids: [...ids], lastUpdated: new Date().toISOString() }, { spaces: 2 });
}

// ── Plaud API ─────────────────────────────────────────────────────────────────

async function fetchPlaudRecordings() {
    if (!PLAUD_API_KEY) throw new Error('PLAUD_API_KEY not set');

    const res = await fetch(`${PLAUD_BASE_URL}/files`, {
        headers: { 'Authorization': `Bearer ${PLAUD_API_KEY}` }
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Plaud API /files error ${res.status}: ${body}`);
    }

    const data = await res.json();
    // API may return { files: [...] } or a plain array
    const files = Array.isArray(data) ? data : (data.files || data.data || []);
    return files.filter(f => f.status === 'completed');
}

async function fetchPlaudFileDetails(fileId) {
    const res = await fetch(`${PLAUD_BASE_URL}/files/${fileId}`, {
        headers: { 'Authorization': `Bearer ${PLAUD_API_KEY}` }
    });
    if (!res.ok) return null;
    return res.json();
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadAudio(presignedUrl, destPath) {
    const res = await fetch(presignedUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buffer);
    return destPath;
}

// ── Google Drive Upload ───────────────────────────────────────────────────────

let driveClient = null;

async function getDriveClient() {
    if (driveClient) return driveClient;
    if (!GOOGLE_SA_PATH || !await fs.pathExists(GOOGLE_SA_PATH)) {
        console.warn('[plaud-sync] Google SA key not found, Drive upload disabled');
        return null;
    }
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_SA_PATH,
        scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
}

async function uploadToDrive(filePath, mimeType, driveName) {
    const drive = await getDriveClient();
    if (!drive || !GOOGLE_DRIVE_FOLDER_ID) {
        console.log('[plaud-sync] Drive upload skipped (not configured)');
        return null;
    }

    try {
        const fileMetadata = {
            name: driveName,
            parents: [GOOGLE_DRIVE_FOLDER_ID]
        };
        const media = {
            mimeType,
            body: fs.createReadStream(filePath)
        };
        const res = await drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, name, webViewLink'
        });
        console.log(`[plaud-sync] ☁️  Uploaded to Drive: ${res.data.name} (${res.data.id})`);
        return res.data;
    } catch (e) {
        console.error('[plaud-sync] Drive upload failed:', e.message);
        return null;
    }
}

// ── Whisper.cpp Transcription ─────────────────────────────────────────────────

async function transcribeWithWhisper(audioPath) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    console.log(`[plaud-sync] 🎙️  Transcribing using OpenAI Whisper API: ${path.basename(audioPath)}`);

    const fileBuffer = await fs.readFile(audioPath);
    const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });

    const form = new FormData();
    form.append('file', blob, path.basename(audioPath));
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: form
    });

    if (!res.ok) {
        const errObj = await res.json().catch(() => ({}));
        throw new Error(`OpenAI API Error: ${res.status} - ${errObj.error?.message || res.statusText}`);
    }

    const json = await res.json();
    if (!json.text) throw new Error('API returned successfully but without transcript text.');
    return json.text;
}

// ── Claude Summarization ──────────────────────────────────────────────────────

function buildClaudePrompt(transcript, recordingName) {
    return `You are analyzing a call recording transcript named "${recordingName}".
The transcript may be in Hinglish (Hindi + English mixed). Always produce output in English.

## Transcript

${transcript}

---

## Instructions

Generate the following sections in Markdown format:

### 📝 Meeting Summary
Write a 5–7 sentence summary of the conversation. Cover who was involved (if identifiable), the main topic, and the outcome.

### ✅ Key Decisions
List all decisions made during the call as a bullet list.

### 📋 Action Items
Create a markdown checklist. For each item, include the owner and deadline if mentioned.
Format: \`- [ ] [Action] — Owner: [name], Deadline: [date if mentioned]\`

### 🧠 Mind Map
Create a Mermaid.js mindmap diagram showing the main topics and their relationships.
Use the \`mindmap\` diagram type. Keep it to 2–3 levels deep with the recording name as the root.

### 🔥 Top 5 Highlights
List the 5 most notable or quotable moments from the conversation.

### 🌐 Language Note
Note if the original transcript was in Hinglish and mention any terms kept in their original language for clarity.`;
}

async function summarizeWithOpenRouter(transcript, recordingName) {
    if (!OPENROUTER_API_KEY) {
        console.warn('[plaud-sync] OPENROUTER_API_KEY not set, skipping OpenRouter summarization');
        return `# ${recordingName}\n\n## Transcript\n\n${transcript}`;
    }

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: SUMMARY_MODEL,
            messages: [{ role: 'user', content: buildClaudePrompt(transcript, recordingName) }]
        })
    });

    if (!res.ok) {
        console.warn(`[plaud-sync] Summarization failed. Status: ${res.status}`);
        return `# ${recordingName}\n\n## Transcript\n\n${transcript}`;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Wrap with metadata header
    const safeTitle = String(recordingName)
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ');
    const header = `---
title: "${safeTitle}"
date: "${new Date().toISOString()}"
source: plaud-sync
model: ${SUMMARY_MODEL}
---

# 🎙️ ${recordingName}

`;

    return header + content;
}

// ── File Naming ───────────────────────────────────────────────────────────────

function buildFilename(recording) {
    const dt = new Date(recording.created_at);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');

    // Sanitize recording name for filesystem
    const name = (recording.name || 'recording')
        .replace(/[^a-zA-Z0-9_\-\s]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 60);

    return `${yyyy}-${mm}-${dd}_${hh}-${min}_${name}`;
}

// ── Process Single Recording ──────────────────────────────────────────────────

async function processRecording(recording, processedIds) {
    const baseName = buildFilename(recording);
    const mp3Name = `${baseName}.mp3`;
    const mdName = `${baseName}.md`;
    const tempAudioPath = path.join(TEMP_DIR, mp3Name);

    console.log(`[plaud-sync] 📥 Processing: ${recording.name || recording.id}`);

    try {
        // 1. Download audio
        if (!recording.presigned_url) {
            // Fetch full file details for presigned URL
            const details = await fetchPlaudFileDetails(recording.id);
            if (!details?.presigned_url) {
                console.error(`[plaud-sync] No presigned_url for ${recording.id}, skipping`);
                return;
            }
            recording = { ...recording, ...details };
        }

        await fs.ensureDir(TEMP_DIR);
        await downloadAudio(recording.presigned_url, tempAudioPath);
        console.log(`[plaud-sync] ⬇️  Downloaded: ${mp3Name}`);

        // 2. Upload to Google Drive
        await uploadToDrive(tempAudioPath, 'audio/mpeg', mp3Name);

        // 3. Transcribe with whisper.cpp (fallback to Plaud API transcript)
        let transcript;
        try {
            transcript = await transcribeWithWhisper(tempAudioPath);
            console.log(`[plaud-sync] ✅ Whisper transcript: ${transcript.length} chars`);
        } catch (whisperErr) {
            console.warn(`[plaud-sync] ⚠️  whisper.cpp failed: ${whisperErr.message}`);
            console.log('[plaud-sync] Falling back to Plaud API transcript...');

            // Fallback: use Plaud API's built-in transcript
            const details = recording.ai_data || (await fetchPlaudFileDetails(recording.id))?.ai_data;
            transcript = details?.transcript || details?.summary || '';

            if (!transcript) {
                console.error(`[plaud-sync] No transcript available for ${recording.id}, skipping`);
                return;
            }
            console.log(`[plaud-sync] 📄 Using Plaud API transcript: ${transcript.length} chars`);
        }

        // 4. Summarize with OpenRouter
        let markdown = await summarizeWithOpenRouter(transcript, recording.name || baseName);

        // 4.5. Tag the file and add frontmatter
        const todayStr = new Date().toISOString().split('T')[0];
        const { tags, agents } = detectTags(transcript);
        markdown = wrapWithFrontmatter(markdown, {
            source: 'plaud-note',
            file: mp3Name,
            tags,
            agents,
            date: todayStr
        });

        // 5. Upload .md to Google Drive
        const tempMdPath = path.join(TEMP_DIR, mdName);
        await fs.writeFile(tempMdPath, markdown, 'utf-8');
        await uploadToDrive(tempMdPath, 'text/markdown', mdName);

        // 6. Drop into audio_inbox for ingest-audio.js
        await fs.ensureDir(AUDIO_INBOX);
        await fs.move(tempAudioPath, path.join(AUDIO_INBOX, mp3Name), { overwrite: true });
        await fs.move(tempMdPath, path.join(AUDIO_INBOX, mdName), { overwrite: true });
        console.log(`[plaud-sync] 📂 Dropped to audio_inbox: ${mp3Name} + ${mdName}`);

        // 7. Mark as processed
        processedIds.add(recording.id);
        await saveProcessedIds(processedIds);

        console.log(`[plaud-sync] ✅ Done: ${recording.name || recording.id}`);
    } catch (e) {
        console.error(`[plaud-sync] ❌ Failed to process ${recording.name || recording.id}: ${e.message}`);
        // Clean up temp files on failure
        await fs.remove(tempAudioPath).catch(() => { });
    }
}

// ── Polling Loop ──────────────────────────────────────────────────────────────

async function poll() {
    try {
        const processedIds = await loadProcessedIds();
        const recordings = await fetchPlaudRecordings();

        const newRecordings = recordings.filter(r => !processedIds.has(r.id));
        if (newRecordings.length === 0) {
            console.log(`[plaud-sync] No new recordings (${recordings.length} total, ${processedIds.size} processed)`);
            return;
        }

        console.log(`[plaud-sync] 🆕 Found ${newRecordings.length} new recording(s)`);

        for (const recording of newRecordings) {
            try {
                await processRecording(recording, processedIds);
            } catch (e) {
                // Per-file error handling — never crash the loop
                console.error(`[plaud-sync] ❌ Uncaught error for ${recording.id}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[plaud-sync] Poll cycle error:', e.message);
    }
}

// ── Startup Validation ────────────────────────────────────────────────────────

function validateConfig() {
    const issues = [];
    if (!PLAUD_API_KEY) issues.push('PLAUD_API_KEY is required');
    if (!OPENAI_API_KEY) issues.push('OPENAI_API_KEY is required for Whisper API transcription');
    if (!OPENROUTER_API_KEY) issues.push('OPENROUTER_API_KEY recommended (summarization disabled without it)');

    if (issues.length > 0) {
        console.warn('[plaud-sync] ⚠️  Configuration issues:');
        issues.forEach(i => console.warn(`  - ${i}`));
    }

    if (!PLAUD_API_KEY) {
        console.error('[plaud-sync] PLAUD_API_KEY is required. Exiting.');
        process.exit(1);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('[plaud-sync] Starting Plaud AI sync service');
console.log(`[plaud-sync] Poll interval: ${POLL_INTERVAL / 1000}s`);
console.log(`[plaud-sync] Audio inbox: ${AUDIO_INBOX}`);
console.log(`[plaud-sync] Drive folder: ${GOOGLE_DRIVE_FOLDER_ID || '(not configured)'}`);

validateConfig();

if (process.argv.includes('--test')) {
    console.log('[plaud-sync] Running in --test mode. Checking API access...');
    fetchPlaudRecordings().then(recs => {
        console.log(`[plaud-sync] ✅ API connection successful. Found ${recs.length} recordings.`);
        if (recs.length > 0) {
            console.log(`[plaud-sync] Sample recording: ${recs[0].name || recs[0].id}`);
        }
        process.exit(0);
    }).catch(err => {
        console.error(`[plaud-sync] ❌ API connection failed: ${err.message}`);
        process.exit(1);
    });
} else {
    // Initial poll, then interval
    poll();
    setInterval(poll, POLL_INTERVAL);
}
