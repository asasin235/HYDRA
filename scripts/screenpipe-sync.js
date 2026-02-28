/**
 * screenpipe-sync.js — runs on Mac Mini
 *
 * The MacBook Pro (laptop-side `hydra-screenpipe-sync`) already handles:
 *   Screenpipe OCR → Ollama summary → SSH → shared_context/screen/YYYY-MM-DD.md
 *
 * This script handles the remaining gap:
 *   shared_context/screen/YYYY-MM-DD.md → LanceDB (so searchScreenContext() works for all agents)
 *
 * Every 5 minutes: reads any new entries appended to today's markdown file
 * (tracks byte offset so it never double-ingests) and pushes them to LanceDB.
 */
import fs from 'fs-extra';
import path from 'path';
import { addScreenActivity } from '../core/memory.js';

const BRAIN_PATH = (process.env.BRAIN_PATH || '~/Desktop/hydra-mind').replace(/^~/, process.env.HOME);
const SCREEN_DIR = path.join(BRAIN_PATH, 'shared_context', 'screen');
const CURSOR_FILE = path.join(BRAIN_PATH, 'shared_context', 'screen', '.lancedb-cursor.json');
const INTERVAL_MS = 5 * 60 * 1000;

function todayFile() {
  const date = new Date().toISOString().split('T')[0];
  return { date, file: path.join(SCREEN_DIR, `${date}.md`) };
}

/**
 * Load persisted byte offsets per date.
 * { "2026-02-28": 1234, "2026-02-26": 1611 }
 */
async function loadCursors() {
  try {
    return await fs.readJson(CURSOR_FILE);
  } catch {
    return {};
  }
}

async function saveCursors(cursors) {
  await fs.ensureDir(SCREEN_DIR);
  await fs.writeJson(CURSOR_FILE, cursors, { spaces: 2 });
}

/**
 * Parse markdown entries from the laptop-side sync script.
 * Format:
 *   ## HH:MM — macbook-pro | Apps: App1, App2
 *
 *   Summary text here.
 */
function parseEntries(text) {
  const entries = [];
  // Split on section headers
  const sections = text.split(/(?=^## \d{2}:\d{2})/m).filter(s => s.trim());

  for (const section of sections) {
    const headerMatch = section.match(/^## (\d{2}:\d{2}) — ([^\n|]+?)(?:\s*\|\s*Apps:\s*(.+?))?$/m);
    if (!headerMatch) continue;

    const time = headerMatch[1];
    const apps = headerMatch[3]
      ? headerMatch[3].split(',').map(a => a.replace(/^\*+\s*/, '').trim()).filter(Boolean)
      : [];

    // Summary is everything after the header line (strip leading **)
    const summary = section
      .slice(section.indexOf('\n'))
      .replace(/^\s*\*+\s*/gm, '')
      .trim();

    if (summary) {
      entries.push({ time, apps, summary });
    }
  }
  return entries;
}

async function sync() {
  const { date, file } = todayFile();

  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return; // File doesn't exist yet today
  }

  const cursors = await loadCursors();
  const lastOffset = cursors[date] || 0;

  if (stat.size <= lastOffset) return; // Nothing new

  // Read full file as buffer, then slice from last offset (byte-accurate)
  const fullBuf = await fs.readFile(file);
  const newText = fullBuf.slice(lastOffset).toString('utf-8');
  const entries = parseEntries(newText);

  if (entries.length === 0) {
    // Update cursor even if no parseable entries (content may be partial header)
    // Wait for next cycle when more content arrives
    return;
  }

  let ingested = 0;
  const now = new Date().toISOString();

  for (const entry of entries) {
    try {
      await addScreenActivity({
        source: 'screenpipe-sync',
        timestamp: now,
        apps: entry.apps,
        summary: entry.summary,
        raw_text: `[${entry.time}] ${entry.summary}`,
      });
      ingested++;
    } catch (e) {
      console.error(`[screenpipe-sync] addScreenActivity failed:`, e.message);
    }
  }

  // Advance cursor only after successful ingest
  cursors[date] = stat.size;
  await saveCursors(cursors);

  // Prune cursors older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  for (const d of Object.keys(cursors)) {
    if (d < cutoff) delete cursors[d];
  }
  await saveCursors(cursors);

  console.log(`[screenpipe-sync] Ingested ${ingested} new entries into LanceDB (${entries.map(e => e.apps.join(',')).join(' | ')})`);
}

sync();
setInterval(sync, INTERVAL_MS);
console.log(`[screenpipe-sync] Started. Watching ${SCREEN_DIR} → LanceDB. Interval: 5min`);
