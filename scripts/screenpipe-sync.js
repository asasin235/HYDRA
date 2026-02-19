/**
 * screenpipe-sync.js — runs on MacBook Pro via PM2
 * Every 5 minutes: reads Screenpipe SQLite, filters relevant OCR entries,
 * writes JSON to SMB share (brain/01_EDMO/screen_context/).
 * Falls back to local buffer if SMB unavailable.
 */
import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const SCREENPIPE_DB = process.env.SCREENPIPE_DB ||
  path.join(os.homedir(), 'Library', 'Application Support', 'screenpipe', 'db.sqlite');

const SMB_SCREEN_CTX = process.env.SCREENPIPE_SMB_CTX ||
  path.join(process.env.PI_SMB_PATH || '/Volumes/brain', 'brain', '01_EDMO', 'screen_context');

const BUFFER_DIR = process.env.SCREENPIPE_BUFFER ||
  path.join(os.homedir(), 'hydra-buffer', 'screen_context');

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

async function isSmbAvailable() {
  try {
    await fs.ensureDir(SMB_SCREEN_CTX);
    const testFile = path.join(SMB_SCREEN_CTX, '.write_test');
    await fs.writeFile(testFile, 'ok');
    await fs.remove(testFile);
    return true;
  } catch {
    return false;
  }
}

async function flushBuffer(targetDir) {
  try {
    const exists = await fs.pathExists(BUFFER_DIR);
    if (!exists) return;
    const files = await fs.readdir(BUFFER_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const src = path.join(BUFFER_DIR, f);
      const dst = path.join(targetDir, f);
      await fs.move(src, dst, { overwrite: true });
    }
    console.log(`[screenpipe-sync] Flushed ${files.length} buffered files to SMB.`);
  } catch (e) {
    console.error('[screenpipe-sync] Buffer flush error:', e.message);
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

    const smbOk = await isSmbAvailable();
    if (smbOk) {
      await flushBuffer(SMB_SCREEN_CTX);
      await fs.writeJson(path.join(SMB_SCREEN_CTX, filename), payload);
      await pruneOldFiles(SMB_SCREEN_CTX);
      console.log(`[screenpipe-sync] Written ${payload.length} entries → SMB (${filename})`);
    } else {
      await fs.ensureDir(BUFFER_DIR);
      await fs.writeJson(path.join(BUFFER_DIR, filename), payload);
      await pruneOldFiles(BUFFER_DIR);
      console.warn(`[screenpipe-sync] SMB unavailable — buffered to ~/hydra-buffer (${filename})`);
    }
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
