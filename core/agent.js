import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';
import express from 'express';
import helmet from 'helmet';
import { checkBudget, recordUsage, isOpen, isPaused } from './bottleneck.js';
import { brainPath, appendBrain, writeBrain } from './filesystem.js';
import { createLogger } from './logger.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3002);

// ── Shared health-check Express app (one server for all agents) ───────────────
const _healthApp = express();
let _healthServer = null;
const _agentRegistry = new Map(); // name → {status,lastRun,tokensUsed,tokensBudget,circuit,startedAt}

function ensureHealthServer() {
  if (_healthServer) return;
  _healthApp.use(helmet());
  _healthApp.get('/health/:agent', async (req, res) => {
    const info = _agentRegistry.get(req.params.agent);
    if (!info) return res.status(404).json({ error: 'agent not registered' });

    // Reflect real circuit / paused state from bottleneck
    let status = 'healthy';
    const circuitOpen = await isOpen(req.params.agent);
    if (circuitOpen) status = 'circuit-open';
    else if (await isPaused(req.params.agent)) status = 'paused';

    res.json({
      agent: req.params.agent,
      status,
      lastRun: info.lastRun || null,
      tokensTodayUsed: info.tokensUsed || 0,
      tokensTodayBudget: info.tokensBudget || 0,
      circuitBreaker: circuitOpen ? 'open' : 'closed',
      uptime: Math.floor((Date.now() - info.startedAt) / 1000)
    });
  });
  _healthApp.get('/health', async (req, res) => {
    const all = {};
    for (const [name, info] of _agentRegistry.entries()) {
      let status = 'healthy';
      if (await isOpen(name)) status = 'circuit-open';
      else if (await isPaused(name)) status = 'paused';
      all[name] = { status, lastRun: info.lastRun, uptime: Math.floor((Date.now() - info.startedAt) / 1000) };
    }
    res.json(all);
  });
  _healthServer = _healthApp.listen(HEALTH_PORT, () => {
    console.log(`[agent:health] server listening on port ${HEALTH_PORT}`);
  });
  _healthServer.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') console.error('[agent:health] server error:', e.message);
  });
}

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

function estimateTokensFromMessages(messages) {
  // Rough heuristic: ~4 chars per token
  const text = messages.map(m => m.content || '').join(' ');
  return Math.ceil(text.length / 4);
}

/**
 * Convert agent tool definitions to OpenAI-compatible tool schemas.
 * Tools should define a `parameters` field following JSON Schema format.
 * @param {Array<{name:string, description:string, parameters?:object, execute:Function}>} tools
 */
function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    }
  }));
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine whether an OpenAI/OpenRouter error is retryable.
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  const msg = err.message || '';
  const status = err.status || err.response?.status;
  // Rate limits, server errors, and timeouts are retryable
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('timeout')
  );
}

/**
 * Call the OpenAI/OpenRouter API with exponential backoff retry.
 * @param {Function} fn - Async function that returns an API response
 * @param {string} agentName - For logging
 * @param {import('winston').Logger} log - Logger instance
 * @param {number} [maxAttempts=3]
 * @returns {Promise<any>}
 */
async function withRetry(fn, agentName, log, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      log.warn(`LLM call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`, {
        error: err.message,
        status: err.status
      });
      await sleep(delayMs);
    }
  }
}

export default class Agent {
  constructor({ name, model, systemPromptPath, tools = [], namespace, tokenBudget = 4000 }) {
    this.name = name;
    this.model = model;
    this.systemPromptPath = systemPromptPath;
    this.tools = tools;
    this.namespace = namespace || (name || 'agent');
    this.tokenBudget = tokenBudget;
    this.systemPrompt = '';
    this._startedAt = Date.now();
    this.log = createLogger(name);

    // Register with health server
    _agentRegistry.set(this.name, { lastRun: null, tokensUsed: 0, tokensBudget: tokenBudget, circuit: 'closed', startedAt: this._startedAt });
    ensureHealthServer();

    // Write heartbeat every 5 minutes
    this._heartbeatInterval = setInterval(() => this.#writeHeartbeat(), 5 * 60 * 1000);
    this.#writeHeartbeat(); // initial heartbeat on startup

    // Graceful shutdown: clear intervals and close health server
    const shutdown = () => {
      this.log.info('Shutting down gracefully…');
      clearInterval(this._heartbeatInterval);
      // Only close the shared health server if this is the last registered agent
      if (_healthServer && _agentRegistry.size <= 1) {
        _healthServer.close(() => {
          this.log.info('Health server closed.');
        });
      }
      _agentRegistry.delete(this.name);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  async reloadPrompt() {
    try {
      if (!this.systemPromptPath) {
        this.systemPrompt = '';
        return this.systemPrompt;
      }
      const resolved = path.isAbsolute(this.systemPromptPath)
        ? this.systemPromptPath
        : path.join(process.cwd(), this.systemPromptPath);
      const exists = await fs.pathExists(resolved);
      this.systemPrompt = exists ? await fs.readFile(resolved, 'utf-8') : '';
      if (!exists) {
        this.log.warn(`System prompt not found at ${resolved} — running without persona`);
      }
      return this.systemPrompt;
    } catch (error) {
      this.log.error('reloadPrompt error', { error: error.message });
      this.systemPrompt = '';
      return '';
    }
  }

  async run(userMessage, context = '') {
    try {
      if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is not set');
      }

      // Ensure prompt is loaded
      if (!this.systemPrompt) {
        await this.reloadPrompt();
      }

      // Build messages
      const messages = [];
      if (this.systemPrompt) {
        messages.push({ role: 'system', content: this.systemPrompt });
      }
      if (context) {
        messages.push({ role: 'system', content: `Additional context for ${this.name}:\n${context}` });
      }
      messages.push({ role: 'user', content: userMessage });

      // Budget enforcement (estimate)
      const estimated = estimateTokensFromMessages(messages);
      const within = await checkBudget(this.name, estimated);
      if (!within) {
        const msg = `Agent ${this.name} budget exceeded or circuit open. Estimated tokens: ${estimated}.`;
        this.log.warn('Blocked by budget/circuit breaker', { estimated, budget: this.tokenBudget });
        await this.#logInteraction(userMessage, '(blocked by budget)', { inputTokens: estimated, outputTokens: 0 });
        return msg;
      }

      const toolsDef = toOpenAITools(this.tools);

      // Initial model call — with retry
      const first = await withRetry(
        () => openai.chat.completions.create({
          model: this.model,
          messages,
          tools: toolsDef,
          tool_choice: toolsDef ? 'auto' : undefined,
          temperature: 0.4
        }),
        this.name,
        this.log
      );

      let promptTokens = first.usage?.prompt_tokens || estimated;
      let completionTokens = first.usage?.completion_tokens || Math.ceil((first.choices?.[0]?.message?.content?.length || 0) / 4);

      let assistantMessage = first.choices?.[0]?.message || { role: 'assistant', content: '' };
      const transcript = [...messages, assistantMessage];

      // Handle tool calls if any
      if (assistantMessage.tool_calls && Array.isArray(assistantMessage.tool_calls) && this.tools?.length) {
        for (const call of assistantMessage.tool_calls) {
          const toolName = call.function?.name;
          const argsRaw = call.function?.arguments || '{}';
          let toolResult = '';
          try {
            const tool = this.tools.find(t => t.name === toolName);
            if (!tool) {
              toolResult = `Tool ${toolName} not found`;
            } else {
              const args = JSON.parse(argsRaw);
              const res = await tool.execute(args);
              toolResult = typeof res === 'string' ? res : JSON.stringify(res);
            }
          } catch (e) {
            toolResult = `Tool execution error: ${e.message}`;
            this.log.error('Tool execution failed', { tool: toolName, error: e.message });
          }
          transcript.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: toolResult
          });
        }

        // Follow-up model call with tool results — also with retry
        const second = await withRetry(
          () => openai.chat.completions.create({
            model: this.model,
            messages: transcript,
            temperature: 0.4
          }),
          this.name,
          this.log
        );
        assistantMessage = second.choices?.[0]?.message || assistantMessage;
        promptTokens += second.usage?.prompt_tokens || 0;
        completionTokens += second.usage?.completion_tokens || 0;
      }

      const finalText = assistantMessage.content || '';

      // Record usage
      await recordUsage(this.name, promptTokens, completionTokens, this.model);

      // Update health registry
      const reg = _agentRegistry.get(this.name) || {};
      reg.lastRun = new Date().toISOString();
      reg.tokensUsed = (reg.tokensUsed || 0) + promptTokens + completionTokens;
      _agentRegistry.set(this.name, reg);

      this.log.info('Run complete', { inputTokens: promptTokens, outputTokens: completionTokens });

      // Log interaction
      await this.#logInteraction(userMessage, finalText, { inputTokens: promptTokens, outputTokens: completionTokens });

      return finalText;
    } catch (error) {
      this.log.error('run error', { error: error.message });
      try {
        await this.#logInteraction(userMessage, `ERROR: ${error.message}`, { inputTokens: 0, outputTokens: 0 });
      } catch { }
      return `Agent ${this.name} failed: ${error.message}`;
    }
  }

  async #writeHeartbeat() {
    try {
      await writeBrain(this.namespace, 'heartbeat.json', { ts: Date.now(), status: 'alive', agent: this.name });
    } catch (e) {
      // Heartbeat write failures are non-fatal — don't log to avoid noise
    }
  }

  async #logInteraction(user, response, usage) {
    try {
      const date = todayDate();
      const filename = `daily_log_${date}.json`;
      const entry = {
        timestamp: new Date().toISOString(),
        user,
        response,
        usage,
        model: this.model
      };
      await appendBrain(this.namespace, filename, entry);
    } catch (error) {
      this.log.error('log error', { error: error.message });
    }
  }
}
