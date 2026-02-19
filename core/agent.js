import fs from 'fs-extra';
import path from 'path';
import OpenAI from 'openai';
import { checkBudget, recordUsage } from './bottleneck.js';
import { brainPath, appendBrain } from './filesystem.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

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

function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true
      }
    }
  }));
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
      return this.systemPrompt;
    } catch (error) {
      console.error(`[agent:${this.name}] reloadPrompt error:`, error.message);
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
      if (!within || estimated > this.tokenBudget) {
        const msg = `Agent ${this.name} budget exceeded. Estimated tokens ${estimated} / limit ${this.tokenBudget}.`;
        await this.#logInteraction(userMessage, '(blocked by budget)', { inputTokens: estimated, outputTokens: 0 });
        return msg;
      }

      const toolsDef = toOpenAITools(this.tools);

      // Initial model call
      const first = await openai.chat.completions.create({
        model: this.model,
        messages,
        tools: toolsDef,
        tool_choice: toolsDef ? 'auto' : undefined,
        temperature: 0.4
      });

      let promptTokens = first.usage?.prompt_tokens || estimated;
      let completionTokens = first.usage?.completion_tokens || (first.choices?.[0]?.message?.content?.length || 0) / 4 | 0;

      let assistantMessage = first.choices?.[0]?.message || { role: 'assistant', content: '' };
      const transcript = [ ...messages, assistantMessage ];

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
          }
          transcript.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: toolResult
          });
        }

        // Follow-up model call with tool results
        const second = await openai.chat.completions.create({
          model: this.model,
          messages: transcript,
          temperature: 0.4
        });
        assistantMessage = second.choices?.[0]?.message || assistantMessage;
        promptTokens += second.usage?.prompt_tokens || 0;
        completionTokens += second.usage?.completion_tokens || 0;
      }

      const finalText = assistantMessage.content || '';

      // Record usage
      await recordUsage(this.name, promptTokens, completionTokens, this.model);

      // Log interaction
      await this.#logInteraction(userMessage, finalText, { inputTokens: promptTokens, outputTokens: completionTokens });

      return finalText;
    } catch (error) {
      console.error(`[agent:${this.name}] run error:`, error.message);
      try {
        await this.#logInteraction(userMessage, `ERROR: ${error.message}`, { inputTokens: 0, outputTokens: 0 });
      } catch {}
      return `Agent ${this.name} failed: ${error.message}`;
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
      console.error(`[agent:${this.name}] log error:`, error.message);
    }
  }
}
