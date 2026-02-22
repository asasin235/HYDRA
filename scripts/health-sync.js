/**
 * health-sync.js — runs on Mac Mini
 * Cron 5:45AM: scans for 'Health Auto Export' iOS app CSV files,
 * parses health metrics, writes consolidated JSON to brain storage.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DOWNLOADS_DIR = process.env.HEALTH_CSV_SOURCE ||
  path.join(os.homedir(), 'Downloads');

const ICLOUD_HEALTH_DIR = process.env.HEALTH_ICLOUD_DIR ||
  path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'HealthAutoExport');

const HEALTH_DATA_DIR = process.env.HEALTH_DATA_DIR ||
  path.join(process.env.BRAIN_PATH || './brain', 'brain', '07_BIOBOT', 'health_data');

// Parse CSV with minimal deps — no external csv package needed
function parseCSV(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || null; });
    return row;
  });
}

function findHeader(headers, patterns) {
  for (const h of headers) {
    for (const p of patterns) {
      if (h.toLowerCase().includes(p.toLowerCase())) return h;
    }
  }
  return null;
}

function parseMetrics(rows, targetDate) {
  if (!rows.length) return null;
  const headers = Object.keys(rows[0]);

  // Find relevant columns
  const dateCol = findHeader(headers, ['date', 'startdate', 'start date', 'creation date']);
  const hrvCol = findHeader(headers, ['hrv', 'heart rate variability', 'sdnn']);
  const sleepHoursCol = findHeader(headers, ['sleep hours', 'time in bed', 'sleep duration', 'asleep']);
  const sleepStartCol = findHeader(headers, ['sleep start', 'bedtime', 'sleep begin']);
  const sleepEndCol = findHeader(headers, ['sleep end', 'wake time', 'wake up']);
  const stepsCol = findHeader(headers, ['step count', 'steps']);
  const restingHRCol = findHeader(headers, ['resting heart rate', 'resting hr']);
  const energyCol = findHeader(headers, ['active energy', 'active calories', 'calories burned']);

  // Filter rows for target date
  const dateRows = targetDate && dateCol
    ? rows.filter(r => (r[dateCol] || '').startsWith(targetDate))
    : rows;

  function numVal(col) {
    if (!col) return null;
    const values = dateRows.map(r => parseFloat(r[col])).filter(n => !isNaN(n));
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length; // avg
  }

  function sumVal(col) {
    if (!col) return null;
    const values = dateRows.map(r => parseFloat(r[col])).filter(n => !isNaN(n));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  }

  function lastVal(col) {
    if (!col) return null;
    const rows2 = dateRows.filter(r => r[col]);
    return rows2.length ? rows2[rows2.length - 1][col] : null;
  }

  const hrv = numVal(hrvCol);
  const sleepHours = numVal(sleepHoursCol) || (sleepStartCol && sleepEndCol
    ? (() => {
      const start = lastVal(sleepStartCol);
      const end = lastVal(sleepEndCol);
      if (!start || !end) return null;
      const ms = new Date(end).getTime() - new Date(start).getTime();
      return ms > 0 ? ms / 3600000 : null;
    })()
    : null);

  return {
    date: targetDate || new Date().toISOString().split('T')[0],
    hrv: hrv ? Math.round(hrv * 10) / 10 : null,
    sleepHours: sleepHours ? Math.round(sleepHours * 10) / 10 : null,
    sleepStart: lastVal(sleepStartCol),
    sleepEnd: lastVal(sleepEndCol),
    steps: sumVal(stepsCol) !== null ? Math.round(sumVal(stepsCol)) : null,
    restingHR: numVal(restingHRCol) ? Math.round(numVal(restingHRCol)) : null,
    activeEnergy: sumVal(energyCol) !== null ? Math.round(sumVal(energyCol)) : null
  };
}

async function findCsvFiles() {
  const csvFiles = [];
  for (const dir of [DOWNLOADS_DIR, ICLOUD_HEALTH_DIR]) {
    try {
      const exists = await fs.pathExists(dir);
      if (!exists) continue;
      const files = (await fs.readdir(dir))
        .filter(f => f.toLowerCase().endsWith('.csv') && /health|export/i.test(f));
      csvFiles.push(...files.map(f => path.join(dir, f)));
    } catch {}
  }
  return csvFiles;
}

async function syncHealthData() {
  try {
    const csvFiles = await findCsvFiles();
    if (!csvFiles.length) {
      console.log('[health-sync] No health CSV files found.');
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    await fs.ensureDir(HEALTH_DATA_DIR);

    let processed = 0;
    for (const csvPath of csvFiles) {
      try {
        const content = await fs.readFile(csvPath, 'utf-8');
        const rows = parseCSV(content);
        if (!rows.length) continue;

        // Extract last 7 days
        const dates = new Set();
        const dateCol = findHeader(Object.keys(rows[0]), ['date', 'startdate', 'start date', 'creation date']);
        if (dateCol) {
          rows.forEach(r => {
            const d = (r[dateCol] || '').split('T')[0].split(' ')[0];
            if (d) dates.add(d);
          });
        } else {
          dates.add(today);
        }

        for (const date of [...dates].sort().slice(-7)) {
          const metrics = parseMetrics(rows, date);
          if (!metrics) continue;
          const outFile = path.join(HEALTH_DATA_DIR, `${date}.json`);
          // Merge with existing if file exists
          if (await fs.pathExists(outFile)) {
            const existing = await fs.readJson(outFile);
            const merged = { ...existing, ...Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== null)) };
            await fs.writeJson(outFile, merged, { spaces: 2 });
          } else {
            await fs.writeJson(outFile, metrics, { spaces: 2 });
          }
        }

        // Delete processed CSV
        await fs.remove(csvPath);
        processed++;
        console.log(`[health-sync] Processed ${path.basename(csvPath)}`);
      } catch (e) {
        console.error(`[health-sync] Error processing ${csvPath}:`, e.message);
      }
    }

    if (processed > 0) {
      console.log(`[health-sync] Done. ${processed} CSV file(s) processed → ${HEALTH_DATA_DIR}`);
    }
  } catch (e) {
    console.error('[health-sync] sync error:', e.message);
  }
}

// Run immediately and also set up cron via interval targeting 5:45AM
syncHealthData();

// Calculate next 5:45AM
function msUntilNext545AM() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(5, 45, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

setTimeout(function scheduleDaily() {
  syncHealthData();
  setInterval(syncHealthData, 24 * 60 * 60 * 1000);
}, msUntilNext545AM());

console.log('[health-sync] Started. Next sync at 5:45AM.');
