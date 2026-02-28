/**
 * core/health-server.js — Dedicated health endpoint server for all HYDRA agents.
 *
 * Agents POST their status here via HTTP. This runs as a standalone PM2 process
 * to avoid the port-collision issue where only the first agent process could
 * bind port 3002.
 *
 * Endpoints:
 *   POST /health/report       — Agents report their status
 *   GET  /health/:agent       — Query single agent
 *   GET  /health              — Overview of all agents
 */
import express from 'express';
import helmet from 'helmet';
import { isOpen, isPaused } from './bottleneck.js';
import { createLogger } from './logger.js';

const log = createLogger('health-server');
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3002);
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const app = express();
app.use(helmet());
app.use(express.json());

// In-memory agent status store
const agentStatus = new Map();

// Agents POST their status here
app.post('/health/report', (req, res) => {
  const { agent, lastRun, tokensUsed, tokensBudget, startedAt } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent name required' });
  agentStatus.set(agent, {
    lastRun: lastRun || null,
    tokensUsed: tokensUsed || 0,
    tokensBudget: tokensBudget || 0,
    startedAt: startedAt || Date.now(),
    reportedAt: Date.now()
  });
  res.json({ ok: true });
});

// Query single agent
app.get('/health/:agent', async (req, res) => {
  const info = agentStatus.get(req.params.agent);
  if (!info) return res.status(404).json({ error: 'agent not registered' });

  let status = 'healthy';
  try {
    if (await isOpen(req.params.agent)) status = 'circuit-open';
    else if (await isPaused(req.params.agent)) status = 'paused';
  } catch { /* bottleneck read failure is non-fatal */ }

  if (Date.now() - info.reportedAt > STALE_THRESHOLD_MS) status = 'stale';

  res.json({
    agent: req.params.agent,
    status,
    lastRun: info.lastRun,
    tokensTodayUsed: info.tokensUsed,
    tokensTodayBudget: info.tokensBudget,
    uptime: Math.floor((Date.now() - info.startedAt) / 1000)
  });
});

// Overview of all agents
app.get('/health', async (req, res) => {
  const all = {};
  for (const [name, info] of agentStatus.entries()) {
    let status = 'healthy';
    try {
      if (await isOpen(name)) status = 'circuit-open';
      else if (await isPaused(name)) status = 'paused';
    } catch { /* non-fatal */ }
    if (Date.now() - info.reportedAt > STALE_THRESHOLD_MS) status = 'stale';
    all[name] = {
      status,
      lastRun: info.lastRun,
      uptime: Math.floor((Date.now() - info.startedAt) / 1000)
    };
  }
  res.json(all);
});

app.listen(HEALTH_PORT, () => {
  log.info(`Health server listening on port ${HEALTH_PORT}`);
});
