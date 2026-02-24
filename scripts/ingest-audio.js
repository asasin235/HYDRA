/**
 * scripts/ingest-audio.js — Audio transcription pipeline for Plaud Note Pro
 *
 * Watches a directory for audio files (MP3/WAV/M4A), transcribes them
 * locally via whisper.cpp, summarizes via local Ollama model,
 * and writes results as Markdown to the shared context directory.
 *
 * If a .md sidecar file exists (produced by plaud-sync.js), the rich
 * AI summary is used directly instead of re-summarizing.
 *
 * Processed files are moved to a 'processed/' subdirectory.
 *
 * Usage:
 *   node scripts/ingest-audio.js
 *   # or via PM2 in ecosystem.config.cjs
 */
import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeAudioTranscript } from '../core/openclaw-memory.js';

const execFileAsync = promisify(execFile);

const AUDIO_INBOX = (process.env.AUDIO_INBOX_DIR || '~/hydra-brain/audio_inbox')
    .replace(/^~/, process.env.HOME);
const PROCESSED_DIR = path.join(AUDIO_INBOX, 'processed');
const WHISPER_CPP_PATH = process.env.WHISPER_CPP_PATH || '/usr/local/bin/whisper-cpp';
const WHISPER_MODEL_PATH = (process.env.WHISPER_MODEL_PATH || '~/models/ggml-large-v3-q5_0.bin')
    .replace(/^~/, process.env.HOME);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const POLL_INTERVAL = Number(process.env.AUDIO_POLL_INTERVAL || 60000); // 60s

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac'];
const MAX_FILE_SIZE_MB = 25;

/**
 * Transcribe audio via local whisper.cpp binary
 */
async function transcribeLocal(filePath) {
    console.log(`[ingest-audio] 🎙️  Transcribing with whisper.cpp: ${path.basename(filePath)}`);

    const { stderr } = await execFileAsync(WHISPER_CPP_PATH, [
        '-m', WHISPER_MODEL_PATH,
        '-f', filePath,
        '--language', 'auto',
        '--output-txt',
        '--no-timestamps'
    ], {
        timeout: 600000, // 10 min max
        maxBuffer: 50 * 1024 * 1024
    });

    // whisper.cpp writes output to <filePath>.txt
    const txtPath = filePath + '.txt';
    if (await fs.pathExists(txtPath)) {
        const transcript = (await fs.readFile(txtPath, 'utf-8')).trim();
        await fs.remove(txtPath); // cleanup
        if (transcript.length > 0) return transcript;
    }

    throw new Error(`whisper.cpp produced no output. stderr: ${stderr?.slice(0, 500)}`);
}

/**
 * Summarize a transcript via local Ollama model (free, no API costs)
 */
async function summarizeLocal(transcript) {
    try {
        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt: `Summarize the following audio transcript in 2-3 concise sentences. Focus on key topics, decisions, and action items.\n\nTranscript:\n${transcript.slice(0, 8000)}`,
                stream: false,
                options: { num_predict: 256 }
            })
        });

        if (!response.ok) {
            console.warn(`[ingest-audio] Ollama returned ${response.status}, using fallback summary`);
            return transcript.slice(0, 200) + '...';
        }

        const data = await response.json();
        return data.response?.trim() || transcript.slice(0, 200) + '...';
    } catch (e) {
        console.warn(`[ingest-audio] Ollama not available (${e.message}), using fallback summary`);
        return transcript.slice(0, 200) + '...';
    }
}

/**
 * Check if a plaud-sync generated .md sidecar file exists alongside the audio.
 * If it does, we can skip transcription + summarization and use the rich output.
 */
async function checkSidecarMarkdown(audioPath) {
    const base = audioPath.replace(/\.[^.]+$/, '');
    const mdPath = base + '.md';
    if (await fs.pathExists(mdPath)) {
        const content = await fs.readFile(mdPath, 'utf-8');
        if (content.length > 50) {
            console.log(`[ingest-audio] 📄 Found .md sidecar from plaud-sync`);
            return { mdPath, content };
        }
    }
    return null;
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
        // Check for rich .md sidecar from plaud-sync.js first
        const sidecar = await checkSidecarMarkdown(filePath);

        let transcript;
        let summary;

        if (sidecar) {
            // plaud-sync already generated a rich Claude summary
            // Extract transcript from sidecar or use the whole thing as summary
            transcript = sidecar.content;
            summary = sidecar.content.slice(0, 500);
        } else {
            // No sidecar — do local transcription + summarization
            // Check for existing Plaud Note transcript first
            transcript = await checkPlaudTranscript(filePath);

            if (!transcript) {
                // Transcribe the audio locally with whisper.cpp
                transcript = await transcribeLocal(filePath);
            }

            if (!transcript || transcript.length < 10) {
                console.warn(`[ingest-audio] ${filename}: empty transcript, skipping`);
                return;
            }

            // Summarize via local Ollama
            summary = await summarizeLocal(transcript);
        }

        const durationS = null; // Could be extracted with ffprobe if needed

        // Write to shared brain
        await writeAudioTranscript('plaud-note', filename, transcript, summary, durationS);

        // Move to processed
        await fs.ensureDir(PROCESSED_DIR);
        await fs.move(filePath, path.join(PROCESSED_DIR, filename), { overwrite: true });

        // Also move any sidecar files (.md, .txt, .json, .srt)
        const base = filePath.replace(/\.[^.]+$/, '');
        for (const ext of ['.md', '.txt', '.json', '.srt']) {
            const sidecarFile = base + ext;
            if (await fs.pathExists(sidecarFile)) {
                await fs.move(sidecarFile, path.join(PROCESSED_DIR, path.basename(sidecarFile)), { overwrite: true });
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
console.log(`[ingest-audio] Mode: local (whisper.cpp + Ollama ${OLLAMA_MODEL})`);
console.log(`[ingest-audio] Whisper binary: ${WHISPER_CPP_PATH}`);
console.log(`[ingest-audio] Whisper model: ${WHISPER_MODEL_PATH}`);
scan();
setInterval(scan, POLL_INTERVAL);
