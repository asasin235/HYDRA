/**
 * screenpipe-sync.js — runs on Mac Mini
 * Every 5 minutes: reads Screenpipe SQLite, filters relevant OCR entries,
 * writes JSON to brain storage (brain/01_EDMO/screen_context/).
 */
import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const SCREENPIPE_DB = process.env.SCREENPIPE_DB ||
  path.join(os.homedir(), 'Library', 'Application Support', 'screenpipe', 'db.sqlite');

const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const SCREEN_CTX_DIR = process.env.SCREENPIPE_CTX_DIR ||
  path.join(BRAIN_PATH, 'brain', '01_EDMO', 'screen_context');

const MAX_FILES = 100;
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const RELEVANT_APPS = ['Cursor', 'Code', 'Slack', 'Jira', 'Chrome', 'Safari', 'Terminal', 'iTerm2'];

function openDb() {
  try {
    return new Database(SCREENPIPE_DB, { readonly: true, timeout: 3000 });
  } catch (e) {
    console.error('[screenpipe-sync] Cannot open Screenpipe DB:', e.message);
    return null;
  }
}

async function pruneOldFiles(dir) {
  try {
    const files = (await fs.readdir(dir))
      .filter(f => f.endsWith('.json'))
      .sort();
    if (files.length > MAX_FILES) {
      const toDelete = files.slice(0, files.length - MAX_FILES);
      for (const f of toDelete) {
        await fs.remove(path.join(dir, f));
      }
    }
  } catch {}
}

async function sync() {
  const db = openDb();
  if (!db) return;

  try {
    const since = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // last 6 min (overlap buffer)
    const appFilter = RELEVANT_APPS.map(() => '?').join(',');

    let entries;
    try {
      // Screenpipe OCR table schema (as of v0.x): ocr_results with columns: id, text, app_name, timestamp
      entries = db.prepare(
        `SELECT id, text, app_name, window_name, timestamp FROM ocr_results 
         WHERE timestamp >= ? AND app_name IN (${appFilter}) 
         ORDER BY timestamp DESC LIMIT 200`
      ).all(since, ...RELEVANT_APPS);
    } catch {
      // Fallback: older schema may not have window_name
      entries = db.prepare(
        `SELECT id, text, app_name, timestamp FROM ocr_results 
         WHERE timestamp >= ? 
         ORDER BY timestamp DESC LIMIT 200`
      ).all(since).filter(e => RELEVANT_APPS.some(app => (e.app_name || '').includes(app)));
    }

    if (!entries || entries.length === 0) {
      db.close();
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const filename = `${ts}.json`;
    const payload = entries.map(e => ({
      id: e.id,
      text: e.text,
      app_name: e.app_name,
      window_name: e.window_name || null,
      timestamp: e.timestamp
    }));

    await fs.ensureDir(SCREEN_CTX_DIR);
    await fs.writeJson(path.join(SCREEN_CTX_DIR, filename), payload);
    await pruneOldFiles(SCREEN_CTX_DIR);
    console.log(`[screenpipe-sync] Written ${payload.length} entries → ${filename}`);
  } catch (e) {
    console.error('[screenpipe-sync] sync error:', e.message);
  } finally {
    try { db.close(); } catch {}
  }
}

// Run immediately and then every 5 minutes
sync();
setInterval(sync, INTERVAL_MS);
console.log('[screenpipe-sync] Started. Syncing every 5 minutes.');
