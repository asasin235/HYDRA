import fs from 'fs-extra';
import path from 'path';
import { TIER1, TIER2, TIER3 } from './registry.js';

const BRAIN_BASE = process.env.BRAIN_PATH || './brain';
const USAGE_DIR = path.join(BRAIN_BASE, 'brain', 'usage');
const MONTHLY_USAGE_FILE = path.join(USAGE_DIR, 'monthly_usage.json');
const PAUSED_AGENTS_FILE = path.join(USAGE_DIR, 'paused_agents.json');
const CIRCUIT_BREAKERS_FILE = path.join(USAGE_DIR, 'circuit_breakers.json');

// Cost per token (in dollars) for different models
const MODEL_RATES = {
  'google/gemini-flash-3': 0.000001,
  'anthropic/claude-sonnet-4': 0.000015,
  'deepseek/deepseek-r1': 0.0000055,
  'mistral/mistral-small-latest': 0.0000004,
  // Common aliases
  'gemini-flash': 0.000001,
  'claude-sonnet': 0.000015,
  'deepseek-r1': 0.0000055,
  'mistral-small': 0.0000004,
  // Default fallback rate
  'default': 0.00001
};

// Monthly budget cap in dollars
const MONTHLY_BUDGET = 50;

// Priority tiers (imported from core/registry.js — single source of truth)

// In-memory circuit breaker state
const failures = new Map(); // agent -> number & timestamps
const OPEN_CIRCUITS = new Set();

// Initialize usage directory
await fs.ensureDir(USAGE_DIR);

/**
 * Get current month key (YYYY-MM)
 */
function getMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Get today's date key (YYYY-MM-DD)
 */
function getDateKey() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Load monthly usage data
 * @returns {Promise<object>} Usage data
 */
async function loadUsage() {
  try {
    const exists = await fs.pathExists(MONTHLY_USAGE_FILE);
    if (!exists) {
      return { month: getMonthKey(), agents: {}, totalCost: 0 };
    }
    const data = await fs.readJson(MONTHLY_USAGE_FILE);
    
    // Reset if new month
    if (data.month !== getMonthKey()) {
      return { month: getMonthKey(), agents: {}, totalCost: 0 };
    }
    return data;
  } catch (error) {
    console.error('[bottleneck] Failed to load usage:', error.message);
    return { month: getMonthKey(), agents: {}, totalCost: 0 };
  }
}

/**
 * Save monthly usage data
 * @param {object} usage - Usage data
 */
async function saveUsage(usage) {
  try {
    await fs.writeJson(MONTHLY_USAGE_FILE, usage, { spaces: 2 });
  } catch (error) {
    console.error('[bottleneck] Failed to save usage:', error.message);
  }
}

/**
 * Load paused agents data
 * @returns {Promise<object>} Paused agents map
 */
async function loadPausedAgents() {
  try {
    const exists = await fs.pathExists(PAUSED_AGENTS_FILE);
    if (!exists) return {};
    return await fs.readJson(PAUSED_AGENTS_FILE);
  } catch (error) {
    return {};
  }
}

/**
 * Save paused agents data
 * @param {object} paused - Paused agents map
 */
async function savePausedAgents(paused) {
  try {
    await fs.writeJson(PAUSED_AGENTS_FILE, paused, { spaces: 2 });
  } catch (error) {
    console.error('[bottleneck] Failed to save paused agents:', error.message);
  }
}

async function loadCircuits() {
  try {
    const exists = await fs.pathExists(CIRCUIT_BREAKERS_FILE);
    if (!exists) return {};
    return await fs.readJson(CIRCUIT_BREAKERS_FILE);
  } catch {
    return {};
  }
}

async function saveCircuits(state) {
  try {
    await fs.writeJson(CIRCUIT_BREAKERS_FILE, state, { spaces: 2 });
  } catch (e) {
    console.error('[bottleneck] Failed to save circuit breakers:', e.message);
  }
}

async function postSlackAlert(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_STATUS_CHANNEL || '#hydra-status';
    if (!token) return;
    const axios = (await import('axios')).default;
    await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) {
    console.error('[bottleneck] Slack alert error:', e.message);
  }
}

/**
 * Check if an agent has budget to make a request
 * @param {string} agentName - Agent identifier
 * @param {number} estimatedTokens - Estimated tokens for the request
 * @returns {Promise<boolean>} True if within budget
 */
export async function checkBudget(agentName, estimatedTokens = 0) {
  try {
    const usage = await loadUsage();
    const paused = await loadPausedAgents();
    const circuits = await loadCircuits();

    // Circuit breaker open?
    if (OPEN_CIRCUITS.has(agentName) || circuits[agentName]?.state === 'OPEN') {
      console.log(`[bottleneck] Circuit OPEN for ${agentName}`);
      return false;
    }

    // Explicit pause file
    if (paused[agentName]?.PAUSED) {
      console.log(`[bottleneck] Agent ${agentName} is paused`);
      return false;
    }

    // Priority tier enforcement by monthly budget utilization
    const utilization = usage.totalCost / MONTHLY_BUDGET; // 0..1

    if (TIER3.includes(agentName) && utilization >= 0.60) {
      return false;
    }
    if (TIER2.includes(agentName) && utilization >= 0.80) {
      return false;
    }

    // Hard cap: at or beyond 100%, only Tier1 proceeds
    if (utilization >= 1.0 && !TIER1.includes(agentName)) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('[bottleneck] checkBudget error:', error.message);
    return true; // Allow on error to not block operations
  }
}

/**
 * Record token usage and calculate cost
 * @param {string} agentName - Agent identifier
 * @param {number} inputTokens - Input tokens used
 * @param {number} outputTokens - Output tokens used
 * @param {string} model - Model used
 */
export async function recordUsage(agentName, inputTokens, outputTokens, model) {
  try {
    const usage = await loadUsage();
    const dateKey = getDateKey();
    
    // Get rate for model (use default if not found)
    const rate = MODEL_RATES[model] || MODEL_RATES['default'];
    const totalTokens = inputTokens + outputTokens;
    const cost = totalTokens * rate;
    
    // Initialize agent data if needed
    if (!usage.agents[agentName]) {
      usage.agents[agentName] = {
        daily: {},
        monthlyTokens: 0,
        monthlyCost: 0
      };
    }
    
    // Update daily stats
    if (!usage.agents[agentName].daily[dateKey]) {
      usage.agents[agentName].daily[dateKey] = { tokens: 0, cost: 0 };
    }
    usage.agents[agentName].daily[dateKey].tokens += totalTokens;
    usage.agents[agentName].daily[dateKey].cost += cost;
    
    // Update monthly stats
    usage.agents[agentName].monthlyTokens += totalTokens;
    usage.agents[agentName].monthlyCost += cost;
    
    // Update total cost
    usage.totalCost += cost;
    
    await saveUsage(usage);
    
    // Check if we need to pause non-critical agents
    if (usage.totalCost > MONTHLY_BUDGET) {
      await pauseNonCriticalAgents(usage);
    }
    
    console.log(`[bottleneck] ${agentName}: ${totalTokens} tokens, $${cost.toFixed(6)} (${model})`);
  } catch (error) {
    console.error('[bottleneck] recordUsage error:', error.message);
  }
}

/**
 * Pause non-critical agents when budget exceeded
 * @param {object} usage - Current usage data
 */
async function pauseNonCriticalAgents(usage) {
  // Critical agents that should never be paused
  const CRITICAL_AGENTS = ['00-architect', '06-cfobot', '01-edmobot'];
  
  const paused = await loadPausedAgents();
  let updated = false;
  
  for (const agent of Object.keys(usage.agents)) {
    if (!CRITICAL_AGENTS.includes(agent) && !paused[agent]?.PAUSED) {
      paused[agent] = { PAUSED: true, reason: 'Monthly budget exceeded', pausedAt: new Date().toISOString() };
      updated = true;
      console.log(`[bottleneck] Paused non-critical agent: ${agent}`);
    }
  }
  
  if (updated) {
    await savePausedAgents(paused);
  }
}

/**
 * Get monthly spend summary
 * @returns {Promise<object>} {total, perAgent}
 */
export async function getMonthlySpend() {
  try {
    const usage = await loadUsage();
    
    const perAgent = {};
    for (const [agent, data] of Object.entries(usage.agents)) {
      perAgent[agent] = {
        tokens: data.monthlyTokens,
        cost: data.monthlyCost
      };
    }
    
    return {
      month: usage.month,
      total: usage.totalCost,
      budget: MONTHLY_BUDGET,
      remaining: MONTHLY_BUDGET - usage.totalCost,
      perAgent
    };
  } catch (error) {
    console.error('[bottleneck] getMonthlySpend error:', error.message);
    return { month: getMonthKey(), total: 0, budget: MONTHLY_BUDGET, remaining: MONTHLY_BUDGET, perAgent: {} };
  }
}

/**
 * Get today's spend for an agent
 * @param {string} agentName - Agent identifier
 * @returns {Promise<object>} {tokens, cost}
 */
export async function getTodaySpend(agentName) {
  try {
    const usage = await loadUsage();
    const dateKey = getDateKey();
    
    const agentData = usage.agents[agentName];
    if (!agentData?.daily?.[dateKey]) {
      return { tokens: 0, cost: 0 };
    }
    
    return agentData.daily[dateKey];
  } catch (error) {
    return { tokens: 0, cost: 0 };
  }
}

/**
 * Unpause an agent manually
 * @param {string} agentName - Agent identifier
 */
export async function unpauseAgent(agentName) {
  try {
    const paused = await loadPausedAgents();
    if (paused[agentName]) {
      delete paused[agentName];
      await savePausedAgents(paused);
      console.log(`[bottleneck] Unpaused agent: ${agentName}`);
    }
  } catch (error) {
    console.error('[bottleneck] unpauseAgent error:', error.message);
  }
}

/** Circuit breaker: record a failure and potentially trip. */
export async function recordFailure(agentName) {
  try {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5 minutes
    const bucket = failures.get(agentName) || [];
    const recent = bucket.filter(ts => now - ts < windowMs);
    recent.push(now);
    failures.set(agentName, recent);
    if (recent.length >= 3) {
      OPEN_CIRCUITS.add(agentName);
      const circuits = await loadCircuits();
      circuits[agentName] = { state: 'OPEN', trippedAt: new Date().toISOString(), reason: '3 failures within 5m' };
      await saveCircuits(circuits);
      await postSlackAlert(`@here ${agentName} circuit breaker tripped — disabled until manual reset`);
    }
  } catch (e) {
    console.error('[bottleneck] recordFailure error:', e.message);
  }
}

export async function resetCircuit(agentName) {
  try {
    OPEN_CIRCUITS.delete(agentName);
    failures.delete(agentName);
    const circuits = await loadCircuits();
    if (circuits[agentName]) {
      circuits[agentName] = { state: 'CLOSED', resetAt: new Date().toISOString() };
      await saveCircuits(circuits);
    }
  } catch (e) {
    console.error('[bottleneck] resetCircuit error:', e.message);
  }
}

export async function isOpen(agentName) {
  const circuits = await loadCircuits();
  return OPEN_CIRCUITS.has(agentName) || circuits[agentName]?.state === 'OPEN';
}

/**
 * Check if an agent is paused
 * @param {string} agentName - Agent identifier
 * @returns {Promise<boolean>} True if paused
 */
export async function isPaused(agentName) {
  try {
    const paused = await loadPausedAgents();
    return paused[agentName]?.PAUSED === true;
  } catch (error) {
    return false;
  }
}
