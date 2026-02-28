import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';
import { checkBudget, recordUsage } from './bottleneck.js';
import { brainPath, appendBrain, writeBrain } from './filesystem.js';
import { searchScreenContext } from './memory.js';
import { addLog, addConversationMessage, getRecentConversation, pruneConversation } from './db.js';
import { AGENTS } from './registry.js';
import { createLogger } from './logger.js';
import { publish } from './bus.js';
import { withTransaction, recordEvent, recordMetric, addAttributes, noticeError } from './nr-instrument.js';

// ── Optional GlitchTip / Sentry error tracking ────────────────────────────────
// Activated by setting GLITCHTIP_DSN in .env. No-op if unset.
let Sentry = null;
if (process.env.GLITCHTIP_DSN) {
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({ dsn: process.env.GLITCHTIP_DSN, tracesSampleRate: 0 });
  } catch (e) {
    console.warn('[agent] GlitchTip/Sentry init failed (agents run normally):', e.message);
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3002);

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
 * Truncate text to fit within a token budget (using chars/4 estimate).
 * Trims to the last complete line to avoid mid-sentence cuts.
 */
function truncateToTokenBudget(text, maxTokens) {
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '\n...[truncated]';
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
  constructor({ name, model, systemPromptPath, tools = [], namespace, tokenBudget = 4000, useScreenContext = true }) {
    this.name = name;
    this.model = model;
    this.systemPromptPath = systemPromptPath;
    this.tools = tools;
    this.namespace = namespace || (name || 'agent');
    this.tokenBudget = tokenBudget;
    this.systemPrompt = '';
    this._startedAt = Date.now();
    this.log = createLogger(name);
    this.useScreenContext = useScreenContext;

    // Read per-agent config from registry
    const agentCfg = AGENTS[this.name] || {};
    this.temperature = agentCfg.temperature ?? 0.4;
    this.maxContextTokens = agentCfg.maxContextTokens || 100000;
    this._conversationHistory = [];
    this._maxHistoryTurns = agentCfg.maxHistoryTurns || 10;
    this._lastRun = null;
    this._tokensUsed = 0;

    // Report to health server + write heartbeat every 5 minutes
    this._reportHealth();
    this._heartbeatInterval = setInterval(() => {
      this.#writeHeartbeat();
      this._reportHealth();
    }, 5 * 60 * 1000);
    this.#writeHeartbeat();

    // Graceful shutdown
    const shutdown = () => {
      this.log.info('Shutting down gracefully…');
      clearInterval(this._heartbeatInterval);
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
    return withTransaction(`HYDRA/${this.name}/run`, 'Agent', async () => {
      addAttributes({ agentName: this.name, model: this.model, namespace: this.namespace });
      try {
      if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY is not set');
      }

      // Ensure prompt is loaded
      if (!this.systemPrompt) {
        await this.reloadPrompt();
      }

      // Auto-inject relevant context from LanceDB (semantic search per agent role)
      let contextSnippets = '';
      if (this.useScreenContext) {
        try {
          const agentCfg = AGENTS[this.name];
          const query = userMessage.slice(0, 200);
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const results = await searchScreenContext(query, { limit: 5, since });
          if (results.length > 0) {
            contextSnippets = results.map(r =>
              `[${r.timestamp}] [${r.apps}] ${r.summary}`
            ).join('\n\n');
          }
        } catch (e) {
          this.log.warn('LanceDB context search failed:', e.message);
        }
      }

      // Guard: truncate context to fit model's context window
      const reservedTokens = 6500; // system prompt + user msg + response headroom
      const maxContextBudget = this.maxContextTokens - reservedTokens;
      if (contextSnippets) {
        contextSnippets = truncateToTokenBudget(contextSnippets, Math.min(maxContextBudget * 0.3, 8000));
      }
      if (context) {
        context = truncateToTokenBudget(context, Math.min(maxContextBudget * 0.5, 16000));
      }

      // Build messages
      const messages = [];
      // Merge screen context into the system prompt (some models handle
      // multiple system messages poorly via OpenRouter)
      let systemContent = this.systemPrompt || '';
      if (contextSnippets) {
        systemContent += `\n\n## Live Screen Activity (last 24h)\n${contextSnippets}`;
      }
      if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
      }
      if (context) {
        messages.push({ role: 'system', content: `Additional context for ${this.name}:\n${context}` });
      }

      // Inject conversation history (in-memory first, SQLite fallback on cold start)
      let history = this._conversationHistory;
      if (history.length === 0) {
        try {
          history = getRecentConversation(this.name, this._maxHistoryTurns * 2);
        } catch (e) {
          this.log.warn('Failed to load conversation history', { error: e.message });
          history = [];
        }
      }
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }

      messages.push({ role: 'user', content: userMessage });

      // Budget enforcement (estimate)
      const estimated = estimateTokensFromMessages(messages);

      // Final safety net: if total still exceeds context window, drop context snippets
      if (estimated > this.maxContextTokens) {
        this.log.warn('Messages exceed context window, dropping context snippets', {
          estimated,
          limit: this.maxContextTokens
        });
        const contextIdx = messages.findIndex(m => m.role === 'system' && m.content?.includes('## Live Screen Activity'));
        if (contextIdx !== -1) {
          // Strip the screen activity section but keep the base system prompt
          messages[contextIdx].content = messages[contextIdx].content.replace(/\n\n## Live Screen Activity[\s\S]*$/, '');
        }
      }

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
          temperature: this.temperature
        }),
        this.name,
        this.log
      );

      let promptTokens = first.usage?.prompt_tokens || estimated;
      let completionTokens = first.usage?.completion_tokens || Math.ceil((first.choices?.[0]?.message?.content?.length || 0) / 4);

      let assistantMessage = first.choices?.[0]?.message || { role: 'assistant', content: '' };
      const transcript = [...messages, assistantMessage];

      // Handle tool calls — multi-round loop
      const MAX_TOOL_ITERATIONS = 10;
      let iterations = 0;

      while (
        assistantMessage.tool_calls &&
        Array.isArray(assistantMessage.tool_calls) &&
        assistantMessage.tool_calls.length > 0 &&
        this.tools?.length &&
        iterations < MAX_TOOL_ITERATIONS
      ) {
        iterations++;

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

        // Re-call LLM with tool results — keep tools available for multi-step reasoning
        const next = await withRetry(
          () => openai.chat.completions.create({
            model: this.model,
            messages: transcript,
            tools: toolsDef,
            tool_choice: 'auto',
            temperature: this.temperature
          }),
          this.name,
          this.log
        );
        assistantMessage = next.choices?.[0]?.message || { role: 'assistant', content: '' };
        transcript.push(assistantMessage);
        promptTokens += next.usage?.prompt_tokens || 0;
        completionTokens += next.usage?.completion_tokens || 0;
      }

      if (iterations >= MAX_TOOL_ITERATIONS) {
        this.log.warn('Hit max tool iterations', { iterations: MAX_TOOL_ITERATIONS });
      }

      const finalText = assistantMessage.content || '';

      // Record usage
      await recordUsage(this.name, promptTokens, completionTokens, this.model);

      // Update health and report to health server
      this._lastRun = new Date().toISOString();
      this._tokensUsed += promptTokens + completionTokens;
      this._reportHealth();

      this.log.info('Run complete', { inputTokens: promptTokens, outputTokens: completionTokens });

      // Log interaction
      await this.#logInteraction(userMessage, finalText, { inputTokens: promptTokens, outputTokens: completionTokens });

      // Persist conversation history
      try {
        this._conversationHistory.push({ role: 'user', content: userMessage });
        this._conversationHistory.push({ role: 'assistant', content: finalText.slice(0, 4000) });
        while (this._conversationHistory.length > this._maxHistoryTurns * 2) {
          this._conversationHistory.shift();
        }
        addConversationMessage(this.name, 'user', userMessage);
        addConversationMessage(this.name, 'assistant', finalText);
        pruneConversation(this.name, 20);
      } catch (e) {
        this.log.warn('Failed to save conversation history', { error: e.message });
      }

      // Emit run event to bus
      publish('agent.run', {
        agent: this.name,
        model: this.model,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        toolIterations: iterations
      }).catch(() => {});

      // New Relic custom metrics and events
      recordMetric(`Custom/Agent/${this.name}/InputTokens`, promptTokens);
      recordMetric(`Custom/Agent/${this.name}/OutputTokens`, completionTokens);
      recordEvent('AgentRun', {
        agent: this.name,
        model: this.model,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        totalTokens: promptTokens + completionTokens,
        toolIterations: iterations,
        responseLength: finalText.length,
      });

      return finalText;
    } catch (error) {
      this.log.error('run error', { error: error.message });
      noticeError(error, { agent: this.name, model: this.model });
      if (Sentry) Sentry.captureException(error, { tags: { agent: this.name, model: this.model } });
      publish('agent.error', { agent: this.name, error: error.message }).catch(() => {});
      try {
        await this.#logInteraction(userMessage, `ERROR: ${error.message}`, { inputTokens: 0, outputTokens: 0 });
      } catch { }
      return `Agent ${this.name} failed: ${error.message}`;
    }
    });
  }

  async #writeHeartbeat() {
    try {
      await writeBrain(this.namespace, 'heartbeat.json', { ts: Date.now(), status: 'alive', agent: this.name });
    } catch (e) {
      // Heartbeat write failures are non-fatal — don't log to avoid noise
    }
  }

  /** Report agent status to the dedicated health server via HTTP POST. */
  _reportHealth() {
    try {
      fetch(`http://localhost:${HEALTH_PORT}/health/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: this.name,
          lastRun: this._lastRun,
          tokensUsed: this._tokensUsed,
          tokensBudget: this.tokenBudget,
          startedAt: this._startedAt
        })
      }).catch(() => {}); // fire-and-forget, non-fatal
    } catch {
      // Health report failure is non-fatal
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
      // Also write to SQLite daily_logs for structured queries
      try { addLog(this.name, date, response.slice(0, 500), (usage?.outputTokens || 0)); } catch { }
    } catch (error) {
      this.log.error('log error', { error: error.message });
    }
  }
}
