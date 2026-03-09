/**
 * scripts/plaud-sync.js — Plaud AI (via temp-URL + S3) → WAV Conversion → HTTP Ingest
 *
 * Two modes:
 *   API mode  — polls Plaud internal web API (needs PLAUD_TOKEN + PLAUD_API_DOMAIN or defaults to api-apse1.plaud.ai)
 *   Watch mode — watches audio_inbox/ for dropped .mp3/.m4a/.wav/.opus files
 *
 * Key improvements from plaud-pipesync integration:
 *   - Correct two-step download: temp-URL → S3 signed URL (no auth needed on S3)
 *   - Full pagination support (50-item pages) — covers all recordings
 *   - Browser-mirrored headers (app-platform, edit-from, origin)
 *   - In-memory WAV conversion via fluent-ffmpeg (16kHz mono pcm_s16le) — no disk I/O
 *   - POSTs to http://localhost:3080/api/ingest/audio (dashboard.js handles transcription + LanceDB write)
 *   - Rich Plaud metadata in request body (scene, serialNumber, hasTranscript, hasSummary, externalId)
 *   - SQLite sync_state table for dedup (crash-safe, not lost on restart)
 *   - Bus event publishing (hydra:audio.ingested) after successful ingest
 *   - Subscribes to hydra:plaud.sync.trigger for on-demand full resync
 *
 * Usage:
 *   node scripts/plaud-sync.js           # API mode (Plaud web API)
 *   node scripts/plaud-sync.js --watch   # Watch mode (audio_inbox folder)
 *   node scripts/plaud-sync.js --test    # Test API connection or setup
 */
import fs from 'fs-extra';
import path from 'path';
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import { publishBus, subscribeBus } from '../core/bus.js';
import { getState, setState } from '../core/db.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const PLAUD_TOKEN = process.env.PLAUD_TOKEN;
const PLAUD_API_DOMAIN = (process.env.PLAUD_API_DOMAIN || 'https://api-apse1.plaud.ai').replace(/\/$/, '');
const PLAUD_API_KEY = process.env.PLAUD_API_KEY; // legacy fallback

const HYDRA_URL = process.env.HYDRA_URL || 'http://localhost:3080';
const HYDRA_API_KEY = process.env.HYDRA_API_KEY;

const BRAIN_PATH = (process.env.BRAIN_PATH || '~/hydra-brain')
    .replace(/^~/, process.env.HOME);
const AUDIO_INBOX = (process.env.AUDIO_INBOX_DIR || '~/hydra-brain/audio_inbox')
    .replace(/^~/, process.env.HOME);
const SHARED_AUDIO = path.join(BRAIN_PATH, 'shared_context', 'audio');
const TEMP_DIR = path.join(BRAIN_PATH, 'brain', 'plaud', 'tmp');

const HAS_PLAUD_API = !!(PLAUD_TOKEN && PLAUD_API_DOMAIN) || !!PLAUD_API_KEY;
const POLL_INTERVAL = Number(process.env.PLAUD_POLL_INTERVAL || 1800000); // 30 min
const WATCH_INTERVAL = Number(process.env.AUDIO_POLL_INTERVAL || 60000); // 1 min

const WATCH_MODE = process.argv.includes('--watch') || !HAS_PLAUD_API;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.opus']);

// ── State Management (SQLite sync_state table) ─────────────────────────────────

const SYNC_STATE_KEY = 'plaud_processed_ids';

function loadProcessedIds() {
    try {
        const data = getState(SYNC_STATE_KEY);
        if (data) {
            return new Set(JSON.parse(data));
        }
    } catch (e) {
        console.error('[plaud-sync] Failed to load sync state:', e.message);
    }
    return new Set();
}

function saveProcessedIds(ids) {
    try {
        setState(SYNC_STATE_KEY, JSON.stringify([...ids]));
    } catch (e) {
        console.error('[plaud-sync] Failed to save sync state:', e.message);
    }
}

// ── Plaud API (internal web API + browser-mirrored headers) ──────────────────

function plaudHeaders() {
    if (PLAUD_TOKEN) {
        const auth = PLAUD_TOKEN.startsWith('bearer ') ? PLAUD_TOKEN : `bearer ${PLAUD_TOKEN}`;
        return {
            'Authorization': auth,
            'Content-Type': 'application/json',
            'app-platform': 'web',
            'edit-from': 'web',
            'origin': 'https://web.plaud.ai'
        };
    }
    if (PLAUD_API_KEY) {
        return {
            'Authorization': `Bearer ${PLAUD_API_KEY}`,
            'Content-Type': 'application/json'
        };
    }
    throw new Error('No Plaud credentials. Set PLAUD_TOKEN + PLAUD_API_DOMAIN in .env');
}

/**
 * Fetch all recordings from Plaud API with pagination.
 * Loads 50 items per page, continues until no more items.
 */
async function listAllPlaudRecordings(isTrash = 0) {
    const headers = plaudHeaders();
    const allFiles = [];
    let skip = 0;
    const limit = 50;

    while (true) {
        const url = `${PLAUD_API_DOMAIN}/file/simple/web?skip=${skip}&limit=${limit}&is_trash=${isTrash}`;
        
        const res = await fetch(url, { headers });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Plaud API ${url} error ${res.status}: ${body}`);
        }

        const data = await res.json();
        const files = data.data_file_list || [];
        
        if (files.length === 0) break;
        allFiles.push(...files);
        
        // Check if we got all items
        if (files.length < limit) break;
        skip += limit;
    }

    return allFiles;
}

/**
 * Get signed S3 URL for a Plaud file (two-step download process).
 * First gets temp URL, then downloads from S3.
 */
async function downloadPlaudAudioBuffer(fileId) {
    const headers = plaudHeaders();
    
    // Step 1: Get temp URL from Plaud API
    const tempUrlRes = await fetch(`${PLAUD_API_DOMAIN}/file/temp-url/${fileId}`, { headers });
    if (!tempUrlRes.ok) {
        throw new Error(`Failed to get temp URL for ${fileId}: ${tempUrlRes.status}`);
    }

    const { temp_url_opus, temp_url } = await tempUrlRes.json();
    const s3Url = temp_url_opus || temp_url; // Prefer opus, fallback to mp3
    
    if (!s3Url) {
        throw new Error(`No download URL in response for ${fileId}`);
    }

    // Step 2: Download from S3 (no auth needed)
    const audioRes = await fetch(s3Url, { 
        signal: AbortSignal.timeout(120000) // 120s timeout
    });
    if (!audioRes.ok) {
        throw new Error(`S3 download failed for ${fileId}: ${audioRes.status}`);
    }

    const buffer = await audioRes.arrayBuffer();
    return Buffer.from(buffer);
}

// ── In-Memory Audio Conversion (fluent-ffmpeg) ───────────────────────────────

/**
 * Convert audio buffer to 16kHz mono PCM WAV format (in-memory, no disk I/O).
 * Uses fluent-ffmpeg with PassThrough streams.
 */
async function convertToWavBuffer(inputBuffer, inputFormat = 'mp3') {
    return new Promise((resolve, reject) => {
        const inputStream = new PassThrough();
        const outputStream = new PassThrough();
        const chunks = [];

        outputStream.on('data', chunk => chunks.push(chunk));
        outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        outputStream.on('error', reject);

        ffmpeg(inputStream)
            .inputFormat(inputFormat)
            .audioFrequency(16000)
            .audioChannels(1)
            .audioCodec('pcm_s16le')
            .format('wav')
            .on('error', (err) => {
                console.error('[plaud-sync] FFmpeg error:', err.message);
                reject(new Error(`Audio conversion failed: ${err.message}`));
            })
            .pipe(outputStream);

        inputStream.end(inputBuffer);
    });
}

// ── HTTP Ingest to Dashboard ──────────────────────────────────────────────────

/**
 * POST audio buffer + metadata to dashboard's /api/ingest/audio endpoint.
 * The dashboard handles transcription, summarization, and LanceDB ingestion.
 */
async function ingestAudioToDashboard(wavBuffer, metadata) {
    const formData = new FormData();
    formData.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('metadata', JSON.stringify(metadata));

    try {
        const res = await fetch(`${HYDRA_URL}/api/ingest/audio`, {
            method: 'POST',
            headers: {
                'x-api-key': HYDRA_API_KEY || ''
            },
            body: formData,
            signal: AbortSignal.timeout(120000) // 2 min timeout for transcription
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Ingest endpoint ${res.status}: ${body}`);
        }

        const result = await res.json();
        return result;
    } catch (e) {
        throw new Error(`Failed to ingest audio to dashboard: ${e.message}`);
    }
}

// ── File Naming ───────────────────────────────────────────────────────────────

function buildFilename(recording) {
    const start_time = recording.start_time || Date.now();
    const dt = typeof start_time === 'string' ? new Date(start_time) : new Date(start_time);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');

    const name = (recording.scene || recording.filename || 'recording')
        .replace(/[^a-zA-Z0-9_\-\s]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 60);

    return `${yyyy}-${mm}-${dd}_${hh}-${min}_${name}`;
}

// ── Process Single Plaud Recording ────────────────────────────────────────────

async function processPlaudRecording(recording, processedIds) {
    const recordingId = recording.id || recording.file_id || recording.fileId;
    const baseName = buildFilename(recording);
    const ext = recording.format || (recording.filename?.split('.').pop()) || 'mp3';
    const audioName = `${baseName}.${ext}`;

    console.log(`[plaud-sync] 📥 Processing: ${recording.filename || recordingId}`);

    try {
        // 1. Download audio buffer from Plaud API → S3
        const audioBuffer = await downloadPlaudAudioBuffer(recordingId);
        console.log(`[plaud-sync] ⬇️  Downloaded: ${audioName} (${audioBuffer.length} bytes)`);

        // 2. Convert to 16kHz mono WAV (in-memory)
        const wavBuffer = await convertToWavBuffer(audioBuffer, ext);
        console.log(`[plaud-sync] 🎵 Converted to WAV: ${wavBuffer.length} bytes`);

        // 3. Build rich metadata for ingest endpoint
        const duration_s = Math.floor((recording.duration || 0) / 1000);
        const metadata = {
            source: 'plaud',
            externalId: recordingId,
            filename: audioName,
            fullname: recording.filename || audioName,
            duration: duration_s,
            startTime: recording.start_time || Date.now(),
            endTime: recording.end_time || (Date.now() + (duration_s * 1000)),
            size: audioBuffer.length,
            // Rich Plaud metadata
            scene: recording.scene || '',
            hasTranscript: recording.ai_data?.transcript ? true : false,
            hasSummary: recording.ai_data?.summary ? true : false,
            serialNumber: recording.serial_number || '',
            editFrom: 'web'
        };

        // 4. POST to dashboard /api/ingest/audio (transcription + LanceDB handled there)
        const ingestResult = await ingestAudioToDashboard(wavBuffer, metadata);
        console.log(`[plaud-sync] ✅ Ingested: ${ingestResult.transcriptId || 'ok'}`);

        // 5. Publish bus event
        await publishBus('audio.ingested', {
            source: 'plaud',
            externalId: recordingId,
            filename: audioName,
            duration: duration_s,
            timestamp: new Date().toISOString()
        }).catch(e => console.warn('[plaud-sync] Bus publish failed:', e.message));

        // 6. Mark as processed
        processedIds.add(recordingId);
        saveProcessedIds(processedIds);

        console.log(`[plaud-sync] ✅ Done: ${recording.filename || recordingId}`);
    } catch (e) {
        console.error(`[plaud-sync] ❌ Failed: ${recording.filename || recordingId}: ${e.message}`);
    }
}

// ── Process Local Audio File (Watch mode) ─────────────────────────────────────

async function processLocalAudioFile(filePath, processedIds) {
    const fileName = path.basename(filePath);
    const fileId = `local:${fileName}`;

    if (processedIds.has(fileId)) return;

    const ext = path.extname(fileName).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return;

    console.log(`[plaud-sync] 📥 Processing local file: ${fileName}`);

    try {
        // 1. Read audio file
        const audioBuffer = await fs.readFile(filePath);
        console.log(`[plaud-sync] 📂 Read: ${fileName} (${audioBuffer.length} bytes)`);

        // 2. Convert to WAV
        const wavBuffer = await convertToWavBuffer(audioBuffer, ext.slice(1));
        console.log(`[plaud-sync] 🎵 Converted to WAV: ${wavBuffer.length} bytes`);

        // 3. Build metadata
        const stats = await fs.stat(filePath);
        const metadata = {
            source: 'local',
            externalId: fileId,
            filename: fileName,
            fullname: fileName,
            duration: 0, // unknown for local files
            startTime: stats.birthtimeMs,
            endTime: stats.mtimeMs,
            size: audioBuffer.length,
            scene: 'local drop',
            hasTranscript: false,
            hasSummary: false,
            serialNumber: '',
            editFrom: 'manual'
        };

        // 4. POST to dashboard
        const ingestResult = await ingestAudioToDashboard(wavBuffer, metadata);
        console.log(`[plaud-sync] ✅ Ingested: ${ingestResult.transcriptId || 'ok'}`);

        // 5. Publish bus event
        await publishBus('audio.ingested', {
            source: 'local',
            externalId: fileId,
            filename: fileName,
            duration: 0,
            timestamp: new Date().toISOString()
        }).catch(e => console.warn('[plaud-sync] Bus publish failed:', e.message));

        // 6. Move to processed subfolder
        const processedDir = path.join(AUDIO_INBOX, 'processed');
        await fs.ensureDir(processedDir);
        await fs.move(filePath, path.join(processedDir, fileName), { overwrite: true });

        // 7. Mark done
        processedIds.add(fileId);
        saveProcessedIds(processedIds);

        console.log(`[plaud-sync] ✅ Done: ${fileName}`);
    } catch (e) {
        console.error(`[plaud-sync] ❌ Failed: ${fileName}: ${e.message}`);
    }
}

// ── Polling Loops ─────────────────────────────────────────────────────────────

async function pollPlaudAPI() {
    try {
        const processedIds = loadProcessedIds();
        const recordings = await listAllPlaudRecordings(0); // 0 = active, 1 = trash, 2 = all
        const newRecordings = recordings.filter(r => {
            const rid = r.id || r.file_id || r.fileId;
            return rid && !processedIds.has(rid);
        });

        if (newRecordings.length === 0) {
            console.log(`[plaud-sync] No new recordings (${recordings.length} total, ${processedIds.size} processed)`);
            return;
        }

        console.log(`[plaud-sync] 🆕 Found ${newRecordings.length} new recording(s)`);
        for (const recording of newRecordings) {
            try {
                await processPlaudRecording(recording, processedIds);
            } catch (e) {
                console.error(`[plaud-sync] ❌ Uncaught error for ${recording.id || recording.file_id}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[plaud-sync] Poll cycle error:', e.message);
    }
}

async function pollLocalFolder() {
    try {
        await fs.ensureDir(AUDIO_INBOX);
        const processedIds = loadProcessedIds();
        const files = await fs.readdir(AUDIO_INBOX);
        const audioFiles = files.filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));

        const newFiles = audioFiles.filter(f => !processedIds.has(`local:${f}`));
        if (newFiles.length === 0) {
            return; // silent — no spam for empty folder
        }

        console.log(`[plaud-sync] 🆕 Found ${newFiles.length} new audio file(s) in inbox`);
        for (const file of newFiles) {
            try {
                await processLocalAudioFile(path.join(AUDIO_INBOX, file), processedIds);
            } catch (e) {
                console.error(`[plaud-sync] ❌ Error processing ${file}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[plaud-sync] Watch cycle error:', e.message);
    }
}

// ── Startup & Bus Subscriptions ───────────────────────────────────────────────

function printConfig() {
    console.log('[plaud-sync] Starting Plaud audio sync service');
    console.log(`[plaud-sync] Mode: ${WATCH_MODE ? 'WATCH (local folder)' : 'API (Plaud web API)'}`);
    console.log(`[plaud-sync] Ingest endpoint: ${HYDRA_URL}/api/ingest/audio`);
    console.log(`[plaud-sync] Audio inbox: ${AUDIO_INBOX}`);
    if (!WATCH_MODE) {
        console.log(`[plaud-sync] Poll interval: ${POLL_INTERVAL / 1000}s (${(POLL_INTERVAL / 60000).toFixed(0)} min)`);
    } else {
        console.log(`[plaud-sync] Watch interval: ${WATCH_INTERVAL / 1000}s`);
    }
}

function validateConfig() {
    const issues = [];

    if (!WATCH_MODE && !HAS_PLAUD_API) {
        issues.push('PLAUD_TOKEN + PLAUD_API_DOMAIN required for API mode (or legacy PLAUD_API_KEY)');
    }

    if (!HYDRA_API_KEY && !WATCH_MODE) {
        issues.push('HYDRA_API_KEY recommended for ingest endpoint authentication');
    }

    if (issues.length > 0) {
        console.warn('[plaud-sync] ⚠️  Configuration issues:');
        issues.forEach(i => console.warn(`  - ${i}`));
    }

    if (!WATCH_MODE && !HAS_PLAUD_API) {
        console.error('[plaud-sync] No Plaud credentials for API mode. Set PLAUD_TOKEN + PLAUD_API_DOMAIN, or use --watch.');
        process.exit(1);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

printConfig();
validateConfig();

if (process.argv.includes('--test')) {
    console.log('[plaud-sync] Running in --test mode...');
    if (HAS_PLAUD_API) {
        listAllPlaudRecordings(0).then(recs => {
            console.log(`[plaud-sync] ✅ Plaud API: ${recs.length} recordings found`);
            console.log(`[plaud-sync] Sample recording:`, recs[0]);
            process.exit(0);
        }).catch(err => {
            console.error(`[plaud-sync] ❌ Plaud API failed: ${err.message}`);
            process.exit(1);
        });
    } else {
        console.log('[plaud-sync] ✅ Watch mode ready. Drop audio files into:', AUDIO_INBOX);
        process.exit(0);
    }
} else {
    // Subscribe to on-demand trigger event
    subscribeBus('plaud.sync.trigger', async () => {
        console.log('[plaud-sync] 📢 Trigger received via bus, running full sync...');
        await pollPlaudAPI();
    }).catch(e => {
        console.warn('[plaud-sync] Bus subscription failed:', e.message);
    });

    if (WATCH_MODE) {
        console.log(`[plaud-sync] 👀 Watching ${AUDIO_INBOX} for audio files...`);
        pollLocalFolder();
        setInterval(pollLocalFolder, WATCH_INTERVAL);
    } else {
        console.log(`[plaud-sync] 🔄 Polling Plaud API every ${(POLL_INTERVAL / 60000).toFixed(0)} min...`);
        pollPlaudAPI();
        setInterval(pollPlaudAPI, POLL_INTERVAL);
    }
}
