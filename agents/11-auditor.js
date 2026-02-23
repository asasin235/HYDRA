/**
 * 11-auditor.js — Weekly reflection orchestrator + auto-rollback
 * Phase 5: Every Sunday 10PM, runs reflection for all agents.
 * Saves week_N.json, posts Slack buttons, auto-rollbacks on score drop.
 */
import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { AGENTS as AGENT_CONFIG } from '../core/registry.js';

validateEnv('11-auditor');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const PROMPTS_DIR = path.join(process.cwd(), 'prompts');

// Auditor uses Gemini Flash for processing multiple agents cheaply
const auditor = new Agent({
  name: '11-auditor',
  model: 'google/gemini-flash-3',
  systemPromptPath: 'prompts/11-auditor.txt',
  tools: [],
  namespace: '11_AUDITOR',
  tokenBudget: 1000000
});

// Agent registry derived from core/registry.js — single source of truth.
// Filter out gateway which has no logs/prompt to reflect on.
const AGENT_REGISTRY = Object.fromEntries(
  Object.entries(AGENT_CONFIG)
    .filter(([name]) => name !== '99-slack-gateway')
    .map(([name, cfg]) => [name, { namespace: cfg.namespace, model: cfg.model, promptFile: cfg.promptFile }])
);

async function postSlack(channel, text, blocks) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    const payload = { channel, text };
    if (blocks) payload.blocks = blocks;
    await axios.post('https://slack.com/api/chat.postMessage', payload, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[11-auditor] Slack post error:', e.message);
  }
}

function getCurrentWeek() {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
}

async function readAgentLogs(namespace) {
  try {
    const dir = path.join(BRAIN_PATH, 'brain', namespace);
    if (!await fs.pathExists(dir)) return [];
    const files = (await fs.readdir(dir))
      .filter(f => f.startsWith('daily_log_') && f.endsWith('.json'))
      .sort()
      .slice(-7);
    const logs = [];
    for (const f of files) {
      try {
        const data = await fs.readJson(path.join(dir, f));
        const entries = Array.isArray(data) ? data : [data];
        logs.push(...entries.slice(-5).map(e => ({
          date: f.replace('daily_log_', '').replace('.json', ''),
          user: (e.user || '').slice(0, 200),
          response: (e.response || '').slice(0, 300),
          model: e.model,
          usage: e.usage
        })));
      } catch {}
    }
    return logs;
  } catch (e) {
    return [];
  }
}

async function loadPrevScore(agentName, weekNum) {
  try {
    const histFile = path.join(BRAIN_PATH, 'brain', AGENT_REGISTRY[agentName]?.namespace || agentName, 'score_history.json');
    const exists = await fs.pathExists(histFile);
    if (!exists) return null;
    const hist = await fs.readJson(histFile);
    return hist[`week_${weekNum - 1}`] ?? null;
  } catch { return null; }
}

async function saveScoreHistory(agentName, weekNum, score) {
  try {
    const ns = AGENT_REGISTRY[agentName]?.namespace || agentName;
    const histFile = path.join(BRAIN_PATH, 'brain', ns, 'score_history.json');
    const existing = (await fs.pathExists(histFile)) ? await fs.readJson(histFile) : {};
    existing[`week_${weekNum}`] = score;
    await fs.writeJson(histFile, existing, { spaces: 2 });
  } catch (e) {
    console.error('[11-auditor] saveScoreHistory error:', e.message);
  }
}

async function runReflection(agentName, weekNum) {
  const info = AGENT_REGISTRY[agentName];
  if (!info) return null;

  try {
    const logs = await readAgentLogs(info.namespace);
    if (!logs.length) {
      console.log(`[11-auditor] No logs for ${agentName} — skipping`);
      return null;
    }

    const logsText = logs.map(l => `[${l.date}] Q: ${l.user} | A: ${l.response}`).join('\n');
    const promptFile = path.join(PROMPTS_DIR, info.promptFile);
    const currentPrompt = (await fs.pathExists(promptFile)) ? await fs.readFile(promptFile, 'utf-8') : '(no prompt)';

    const reviewRequest = `You are reviewing ${agentName} (model: ${info.model}). 

Current system prompt:
${currentPrompt.slice(0, 500)}

Performance logs from past 7 days:
${logsText.slice(0, 2000)}

Task: Score performance 1-10, identify top 2 failures, propose 2 specific system prompt changes.
Return ONLY valid JSON: {"score": number, "strengths": [string], "failures": [string], "prompt_changes": [{"current_text": string, "proposed_text": string, "reason": string}]}`;

    const responseText = await auditor.run(reviewRequest, '');
    let parsed;
    try {
      const match = responseText.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch { parsed = null; }

    if (!parsed || typeof parsed.score !== 'number') {
      parsed = { score: 5, strengths: [], failures: ['Failed to parse reflection'], prompt_changes: [] };
    }

    // Save reflection
    const reflDir = path.join(BRAIN_PATH, 'brain', info.namespace, 'reflections');
    await fs.ensureDir(reflDir);
    const reflFile = path.join(reflDir, `week_${weekNum}.json`);
    await fs.writeJson(reflFile, { agentName, weekNum, ...parsed, generatedAt: new Date().toISOString() }, { spaces: 2 });

    return parsed;
  } catch (e) {
    console.error(`[11-auditor] reflection failed for ${agentName}:`, e.message);
    return null;
  }
}

async function checkAndRollback(agentName, weekNum, currentScore) {
  try {
    const prevScore = await loadPrevScore(agentName, weekNum);
    if (prevScore === null) {
      await postSlack(`#11-auditor`, `✅ ${agentName} W${weekNum}: ${currentScore}/10 (first reflection — no comparison).`);
      return;
    }

    const delta = currentScore - prevScore;
    if (delta < -2) {
      // Auto-rollback
      try {
        execSync(`git -C ${process.cwd()} revert HEAD --no-edit`, { timeout: 10000 });
        execSync(`pm2 restart ${agentName} --no-color 2>/dev/null || true`, { timeout: 5000 });
      } catch (execErr) {
        console.error(`[11-auditor] rollback exec error for ${agentName}:`, execErr.message);
      }
      await postSlack(
        '#11-auditor',
        `⚠️ ${agentName} score dropped ${Math.abs(delta)} pts (W${weekNum - 1}:${prevScore} → W${weekNum}:${currentScore}). Auto-reverted prompt. Review git diff.`
      );
    } else {
      const deltaStr = delta >= 0 ? `+${delta}` : String(delta);
      await postSlack('#11-auditor', `✅ ${agentName} W${weekNum}: ${currentScore}/10 (${deltaStr}). Deployed.`);
    }
  } catch (e) {
    console.error('[11-auditor] checkAndRollback error:', e.message);
  }
}

async function runWeeklyReflections() {
  const weekNum = getCurrentWeek();
  console.log(`[11-auditor] Running weekly reflections for week ${weekNum}...`);

  for (const [agentName] of Object.entries(AGENT_REGISTRY)) {
    try {
      const reflection = await runReflection(agentName, weekNum);
      if (!reflection) continue;

      const channel = `#${agentName}-reflect`;
      const summary = [
        `*${agentName} — Week ${weekNum} Reflection*`,
        `Score: ${reflection.score}/10`,
        `Strengths: ${(reflection.strengths || []).join('; ') || 'none listed'}`,
        `Failures: ${(reflection.failures || []).join('; ') || 'none listed'}`,
        `Proposed changes: ${(reflection.prompt_changes || []).length}`
      ].join('\n');

      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: summary } },
        {
          type: 'actions',
          block_id: `reflect_${agentName}_${weekNum}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve Changes' },
              value: `${agentName}|${weekNum}`,
              action_id: 'reflect_approve',
              style: 'primary'
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '⏭ Skip' },
              value: `${agentName}|${weekNum}`,
              action_id: 'reflect_skip'
            }
          ]
        }
      ];

      await postSlack(channel, summary, blocks);

      // Save score history and check rollback AFTER posting
      await saveScoreHistory(agentName, weekNum, reflection.score);
      await checkAndRollback(agentName, weekNum, reflection.score);

      // Small delay to avoid hitting Slack rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[11-auditor] agent loop error for ${agentName}:`, e.message);
    }
  }

  console.log('[11-auditor] Weekly reflections complete.');
}

// Every Sunday 10PM
cron.schedule('0 22 * * 0', async () => { await runWeeklyReflections(); }, { timezone: process.env.TZ || 'Asia/Kolkata' });

export { runWeeklyReflections, AGENT_REGISTRY };

if (process.argv.includes('--reflect-now')) {
  runWeeklyReflections();
}
