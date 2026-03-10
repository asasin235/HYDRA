---
name: hydra-agent-dev
description: "Develop and modify HYDRA agents, core modules, and data pipelines. Use this skill when implementing new agent features, modifying core modules, adding tools to agents, or building new data pipelines."
---

# HYDRA Agent Development Guide

## Adding a New Agent

### 1. Register in `core/registry.js`
```js
'XX-agentname': {
  model: 'google/gemini-2.5-flash',    // or claude, mistral
  temperature: 0.4,                     // 0.1 for deterministic, 0.7+ for creative
  tier: 2,                              // 1=always, 2=pause@80%, 3=pause@60%
  namespace: 'XX_AGENTNAME',            // filesystem namespace
  contextQuery: 'relevant search terms', // for LanceDB context injection
  maxHistoryTurns: 10,                  // conversation history depth
  maxContextTokens: 32000,             // model-specific limit
}
```

### 2. Create system prompt at `prompts/XX-agentname.txt`
- Keep under 2000 tokens
- Include: role, data access, output format, behavioral guidelines
- Never duplicate instructions (the auditor can cause this — check for repetition)

### 3. Create agent file at `agents/XX-agentname.js`
```js
import { Agent } from '../core/agent.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('XX-agentname');
const agent = new Agent('XX-agentname');

// Add cron schedules if proactive
// Handle SIGTERM for graceful shutdown
process.on('SIGTERM', () => { /* cleanup */ });
```

### 4. Add tools in `agents/99-slack-gateway.js`
- Add to the `AGENT_TOOLS` map with OpenAI function-calling format
- Implement tool execution in the gateway's tool dispatch

### 5. Add PM2 entry in `ecosystem.config.cjs`
```js
{
  name: 'XX-agentname',
  script: 'agents/XX-agentname.js',
  node_args: '--require newrelic --require dotenv/config',
  max_memory_restart: '512M',
  autorestart: true,
}
```

## Modifying `core/agent.js`

The agent base class handles:
- System prompt loading from `prompts/` directory
- Context injection via LanceDB `searchAllContext()`
- Conversation history from SQLite `conversation_history` table
- Multi-round tool call loop (MAX_TOOL_ITERATIONS = 15)
- Budget checking via `core/bottleneck.js`
- Token usage recording
- Bus event publishing on completion

**Be careful modifying this file** — it affects all 13 agents.

## Adding New SQLite Tables

All schema changes go in `core/db.js` `initDB()`:
```js
db.exec(`CREATE TABLE IF NOT EXISTS table_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  -- columns here
)`);
```

Then add CRUD functions in the same file and export them.

## Adding New Bus Events

In `core/bus.js`, document the event in the channel list:
```js
// Channels:
// hydra:agent.run       — completed agent runs
// hydra:agent.error     — agent failures
// hydra:health.alert    — biobot signals
// hydra:budget.warning  — spend alerts
// hydra:market.signal   — trading signals
// hydra:audio.ingested  — plaud-sync triggers
// hydra:recording.triaged — audio triage complete
```

Publish: `publish('hydra:channel.name', { data })`
Subscribe: `subscribe('hydra:channel.name', (payload) => { ... })`

## Testing Checklist
- [ ] Agent starts without errors: `pm2 start ecosystem.config.cjs --only XX-agentname`
- [ ] Env vars validated: `validateEnv([...])` called on startup
- [ ] Budget check works: agent pauses when budget exceeded
- [ ] Tool calls execute correctly via Slack
- [ ] Graceful shutdown: no orphaned intervals on SIGTERM
- [ ] Logs are structured: check `pm2 logs XX-agentname`
