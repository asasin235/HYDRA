import cron from 'node-cron';
import fs from 'fs-extra';
import path from 'path';
import { exec as _exec } from 'child_process';
import axios from 'axios';
import util from 'util';

const exec = util.promisify(_exec);

const PI_SMB_PATH = process.env.PI_SMB_PATH || './brain';
const BRAIN_ROOT = path.join(PI_SMB_PATH, 'brain');
const LOGS_DIR = path.join(process.cwd(), 'logs');
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const STATUS_CHANNEL = process.env.SLACK_STATUS_CHANNEL || '#hydra-status';

async function deleteOlderThan(dir, days, pattern = /.*/) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let count = 0;
  try {
    const exists = await fs.pathExists(dir);
    if (!exists) return 0;
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      const fp = path.join(dir, name);
      const stat = await fs.stat(fp).catch(() => null);
      if (!stat) continue;
      if (stat.isFile() && pattern.test(name) && stat.mtimeMs < cutoff) {
        await fs.remove(fp);
        count++;
      } else if (stat.isDirectory()) {
        count += await deleteOlderThan(fp, days, pattern);
      }
    }
  } catch (e) {
    console.error('[cleanup] deleteOlderThan error:', e.message, dir);
  }
  return count;
}

async function rotateLargeLogs(dir, maxBytes) {
  let rotated = 0;
  try {
    const exists = await fs.pathExists(dir);
    if (!exists) return 0;
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.log')) continue;
      const fp = path.join(dir, name);
      const stat = await fs.stat(fp).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (stat.size > maxBytes) {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
        const target = path.join(dir, `${name}.${stamp}.bak`);
        await fs.move(fp, target, { overwrite: true });
        await fs.ensureFile(fp); // recreate empty log
        rotated++;
      }
    }
  } catch (e) {
    console.error('[cleanup] rotateLargeLogs error:', e.message);
  }
  return rotated;
}

async function getDiskSummary() {
  try {
    const { stdout } = await exec('df -k .');
    const lines = stdout.trim().split(/\n/);
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const usedKB = parseInt(parts[2], 10);
      const totalKB = parseInt(parts[1], 10);
      return {
        usedGB: (usedKB / (1024 * 1024)).toFixed(1),
        totalGB: (totalKB / (1024 * 1024)).toFixed(1)
      };
    }
  } catch (e) {
    console.error('[cleanup] getDiskSummary error:', e.message);
  }
  return { usedGB: '0.0', totalGB: '0.0' };
}

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: STATUS_CHANNEL,
      text
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (e) {
    console.error('[cleanup] Slack post error:', e.message);
  }
}

export async function runCleanup() {
  let cleaned = 0;
  try {
    // (1) Screen context older than 7 days
    cleaned += await deleteOlderThan(path.join(BRAIN_ROOT, '01_EDMO', 'screen_context'), 7);

    // (2) audio_inbox .wav/.m4a older than 1 day
    cleaned += await deleteOlderThan(path.join(BRAIN_ROOT, 'audio_inbox'), 1, /\.(wav|m4a)$/i);

    // (3) _transcripts older than 30 days
    cleaned += await deleteOlderThan(path.join(BRAIN_ROOT, '_transcripts'), 30);

    // (4) daily_log_*.json older than 90 days in each agent namespace
    const brainExists = await fs.pathExists(BRAIN_ROOT);
    if (brainExists) {
      const namespaces = await fs.readdir(BRAIN_ROOT);
      for (const ns of namespaces) {
        const full = path.join(BRAIN_ROOT, ns);
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isDirectory()) {
          cleaned += await deleteOlderThan(full, 90, /^daily_log_.*\.json$/i);
        }
      }
    }

    // (5) Rotate logs larger than 50MB
    const rotated = await rotateLargeLogs(LOGS_DIR, 50 * 1024 * 1024);

    // Disk summary
    const disk = await getDiskSummary();

    // (6) Post Slack summary
    await postSlack(`Disk: ${disk.usedGB}/${disk.totalGB}GB. Cleaned ${cleaned} files. Rotated ${rotated} logs.`);

    return { cleaned, rotated, disk };
  } catch (e) {
    console.error('[cleanup] runCleanup error:', e.message);
    return { cleaned, rotated: 0, disk: { usedGB: '0.0', totalGB: '0.0' } };
  }
}

// Schedule at 02:00 daily
cron.schedule('0 2 * * *', async () => {
  await runCleanup();
}, { timezone: process.env.TZ || 'UTC' });

// Allow ad-hoc execution
if (process.argv.includes('--now')) {
  runCleanup().then(res => {
    console.log('[cleanup] Completed:', res);
  });
}
