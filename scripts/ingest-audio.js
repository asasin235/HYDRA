/**
 * scripts/ingest-audio.js — Audio transcription pipeline for Plaud Note Pro
 *
 * Watches a directory for audio files (MP3/WAV/M4A), transcribes them
 * via OpenAI Whisper API (through OpenRouter), summarizes via local Ollama
 * or OpenRouter, and writes results as Markdown to the shared context directory.
 *
 * Processed files are moved to a 'processed/' subdirectory.
 *
 * Usage:
 *   node scripts/ingest-audio.js
 *   # or via PM2 in ecosystem.config.cjs
 */
import fs from 'fs-extra';
import path from 'path';
import { writeAudioTranscript } from '../core/openclaw-memory.js';

const AUDIO_INBOX = (process.env.AUDIO_INBOX_DIR || '~/hydra-brain/audio_inbox')
    .replace(/^~/, process.env.HOME);
const PROCESSED_DIR = path.join(AUDIO_INBOX, 'processed');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHISPER_MODE = process.env.WHISPER_MODE || 'api'; // 'api' or 'local'
const POLL_INTERVAL = Number(process.env.AUDIO_POLL_INTERVAL || 60000); // 60s

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac'];
const MAX_FILE_SIZE_MB = 25; // Whisper API limit

/**
 * Transcribe audio via OpenRouter Whisper API
 */
async function transcribeViaAPI(filePath) {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not set');
    }

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('model', 'openai/whisper-1');

    const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://hydra.local',
            'X-Title': 'HYDRA'
        },
        body: formData
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Whisper API error: ${error}`);
    }

    const data = await response.json();
    return data.text || '';
}

/**
 * Transcribe audio via local OpenClaw whisper skill
 */
async function transcribeLocal(filePath) {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';

    const { stdout } = await execFileAsync(openclawBin, [
        'agent', '--message', `Transcribe this audio file: ${filePath}`, '--json'
    ], { timeout: 120000, env: { ...process.env } });

    return stdout.trim();
}

/**
 * Summarize a transcript via OpenRouter (Gemini Flash — cheap)
 */
async function summarizeTranscript(transcript) {
    if (!OPENROUTER_API_KEY) {
        // Fallback: first 200 chars
        return transcript.slice(0, 200) + '...';
    }

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://hydra.local',
                'X-Title': 'HYDRA'
            },
            body: JSON.stringify({
                model: 'google/gemini-2.0-flash-001',
                messages: [
                    {
                        role: 'system',
                        content: 'Summarize the following audio transcript in 2-3 concise sentences. Focus on key topics, decisions, and action items.'
                    },
                    { role: 'user', content: transcript.slice(0, 8000) }
                ],
                max_tokens: 200
            })
        });

        if (!response.ok) return transcript.slice(0, 200) + '...';
        const data = await response.json();
        return data.choices?.[0]?.message?.content || transcript.slice(0, 200);
    } catch {
        return transcript.slice(0, 200) + '...';
    }
}

/**
 * Check if a Plaud Note TXT/JSON transcript exists alongside the audio file.
 * Plaud exports transcripts with the same name as the audio file.
 */
async function checkPlaudTranscript(audioPath) {
    const base = audioPath.replace(/\.[^.]+$/, '');
    for (const ext of ['.txt', '.json', '.srt']) {
        const transcriptPath = base + ext;
        if (await fs.pathExists(transcriptPath)) {
            const content = await fs.readFile(transcriptPath, 'utf-8');
            if (ext === '.json') {
                try {
                    const data = JSON.parse(content);
                    return data.transcript || data.text || content;
                } catch { return content; }
            }
            return content;
        }
    }
    return null;
}

/**
 * Process a single audio file
 */
async function processAudioFile(filePath) {
    const filename = path.basename(filePath);
    const stat = await fs.stat(filePath);
    const sizeMB = stat.size / (1024 * 1024);

    console.log(`[ingest-audio] Processing: ${filename} (${sizeMB.toFixed(1)}MB)`);

    if (sizeMB > MAX_FILE_SIZE_MB) {
        console.warn(`[ingest-audio] ${filename} exceeds ${MAX_FILE_SIZE_MB}MB, skipping`);
        return;
    }

    try {
        // Check for existing Plaud Note transcript first
        let transcript = await checkPlaudTranscript(filePath);

        if (!transcript) {
            // Transcribe the audio
            transcript = WHISPER_MODE === 'local'
                ? await transcribeLocal(filePath)
                : await transcribeViaAPI(filePath);
        }

        if (!transcript || transcript.length < 10) {
            console.warn(`[ingest-audio] ${filename}: empty transcript, skipping`);
            return;
        }

        // Summarize
        const summary = await summarizeTranscript(transcript);
        const durationS = null; // Could be extracted with ffprobe if needed

        // Write to shared brain
        await writeAudioTranscript('plaud-note', filename, transcript, summary, durationS);

        // Move to processed
        await fs.ensureDir(PROCESSED_DIR);
        await fs.move(filePath, path.join(PROCESSED_DIR, filename), { overwrite: true });

        // Also move any sidecar transcript files
        const base = filePath.replace(/\.[^.]+$/, '');
        for (const ext of ['.txt', '.json', '.srt']) {
            const sidecar = base + ext;
            if (await fs.pathExists(sidecar)) {
                await fs.move(sidecar, path.join(PROCESSED_DIR, path.basename(sidecar)), { overwrite: true });
            }
        }

        console.log(`[ingest-audio] ✅ ${filename} → transcribed + written to shared brain`);
    } catch (e) {
        console.error(`[ingest-audio] ❌ ${filename}: ${e.message}`);
    }
}

/**
 * Scan inbox and process new audio files
 */
async function scan() {
    try {
        await fs.ensureDir(AUDIO_INBOX);
        const files = await fs.readdir(AUDIO_INBOX);
        const audioFiles = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return AUDIO_EXTENSIONS.includes(ext);
        });

        if (audioFiles.length === 0) return;

        console.log(`[ingest-audio] Found ${audioFiles.length} audio file(s)`);
        for (const f of audioFiles) {
            await processAudioFile(path.join(AUDIO_INBOX, f));
        }
    } catch (e) {
        console.error('[ingest-audio] scan error:', e.message);
    }
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

console.log(`[ingest-audio] Watching ${AUDIO_INBOX} (poll every ${POLL_INTERVAL / 1000}s)`);
console.log(`[ingest-audio] Whisper mode: ${WHISPER_MODE}`);
scan();
setInterval(scan, POLL_INTERVAL);
