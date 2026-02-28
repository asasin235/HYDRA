# HYDRA — Copilot Instructions

## What This Is

HYDRA is a multi-agent AI personal operating system. Each agent is a standalone Node.js process managed by PM2, communicating via Slack (Socket Mode) and a Redis event bus. Agents call LLMs through OpenRouter (OpenAI-compatible API) and persist state in SQLite + LanceDB (vector memory). The system runs on a Mac Mini (macOS, Apple Silicon, Node 22+).

## Project Structure

- `core/` — Shared infrastructure imported by every agent. **Never duplicate logic that belongs here.**
  - `agent.js` — Base `Agent` class: LLM calls (OpenRouter), tool-calling loop (max 10 iterations), retry with exponential backoff, budget checks, heartbeat, conversation history, Winston logging
  - `registry.js` — **Single source of truth** for all agent config (model, namespace, tier, promptFile, temperature, contextQuery, slackChannel). Always import from here; never hardcode agent metadata.
  - `bottleneck.js` — $50/month budget cap, 3-tier priority system (Tier 1 runs to 100%, Tier 2 pauses at 80%, Tier 3 at 60%), circuit breaker (3 failures in 5 min → disabled)
  - `db.js` — SQLite via `better-sqlite3` (WAL mode). Tables: `agent_state`, `debt_tracker`, `daily_logs`, `paper_trades`, `leads`, `transactions`, `conversation_history`
  - `memory.js` — LanceDB vector store. Embedding: `text-embedding-3-small` (1536-dim) via OpenRouter. Tables: `memories`, `daily_logs`, `reflections`, `screen_activity`, `audio_transcripts`, `context_feed`
  - `bus.js` — Redis pub/sub (`ioredis`). Channels: `hydra:agent.run`, `hydra:agent.error`, `hydra:health.alert`, `hydra:budget.warning`, `hydra:market.signal`
  - `filesystem.js` — Brain storage helpers (`readBrain`, `writeBrain`, `appendBrain`) with path traversal protection. All agent data lives under `$BRAIN_PATH/brain/<NAMESPACE>/`
  - `hermes-bridge.js` — Messaging gateway (WhatsApp, Telegram, Discord) via Hermes CLI binary
  - `openclaw-memory.js` — Writes Markdown context to `~/hydra-brain/shared_context/` (screen, audio, notes)
  - `validate-env.js` — Per-agent env validation. Call `validateEnv('agent-name')` at top of every agent file.
  - `logger.js` — `createLogger('name')` → Winston. JSON in PM2 production, pretty-print in dev.
  - `nr-instrument.js` — New Relic wrappers (`withTransaction`, `recordEvent`, `recordMetric`). No-ops if NR not loaded.
- `agents/` — One file per agent (e.g., `00-architect.js`, `06-cfobot.js`). Each uses `node-cron` for scheduled tasks and instantiates `Agent` from `core/agent.js`.
- `prompts/` — System prompt `.txt` files, one per agent, referenced by `core/registry.js` `promptFile` field.
- `scripts/` — Data pipelines and utilities, each a long-running PM2 process (see **Scripts & Pipelines** below).
- `mcp/` — MCP stdio server exposing HYDRA tools to external AI clients (see **MCP Server** below).
- `ecosystem.config.cjs` — PM2 process definitions. Uses `app()` helper for agents, `script()` for pipelines.

## Key Patterns

### Creating or Modifying an Agent

1. Add config to `core/registry.js` AGENTS object (namespace, model, tier, promptFile, etc.)
2. Create `agents/XX-name.js` — import `Agent` from `core/agent.js`, call `validateEnv('XX-name')` at top
3. Create `prompts/XX-name.txt` for system prompt
4. Add to `ecosystem.config.cjs` via `app('XX-name')`
5. Agent tools: define as `{ name, description, parameters, execute }` objects passed to `Agent` constructor

### Agent Tool Definition Pattern (from edmobot, jarvis, etc.)

```js
const tools = [
  {
    name: 'tool_name',
    description: 'What this tool does',
    parameters: {
      type: 'object',
      properties: { param: { type: 'string', description: '...' } },
      required: ['param']
    },
    execute: async ({ param }) => { /* return string */ }
  }
];
const agent = new Agent({ name: 'XX-name', model: '...', systemPromptPath: 'prompts/XX-name.txt', tools, namespace: 'XX_NAME' });
```

### Non-LLM Agents

`08-watchtower` is a pure monitoring agent — no `Agent` base class, no LLM calls, zero token cost. It uses `createLogger`, `readBrain/writeBrain`, and PM2 CLI directly. Use this pattern for infrastructure-only agents.

### Storage Layout

- `$BRAIN_PATH/brain/<NAMESPACE>/` — Per-agent JSON state (daily logs, heartbeat, config)
- `$BRAIN_PATH/brain/usage/` — Budget tracking JSONs (monthly_usage, paused_agents, circuit_breakers)
- `$BRAIN_PATH/lancedb/` — LanceDB vector tables
- `$BRAIN_PATH/brain/hydra.db` — SQLite database
- `$BRAIN_PATH/shared_context/screen/` — Daily Markdown files from Screenpipe OCR (laptop → Mac Mini via SSH)
- `$BRAIN_PATH/shared_context/audio/` — Audio transcript Markdown files from Plaud/whisper.cpp
- `$EXTERNAL_SSD_PATH/` — Heavy data (audio files, screenpipe captures, backups)

### Scripts & Data Pipelines

All scripts run as persistent PM2 processes (defined via `script()` in `ecosystem.config.cjs`). They poll on intervals, not cron.

| Script | Purpose | Interval | Data Flow |
|---|---|---|---|
| `plaud-sync.js` | Syncs Plaud Note Pro recordings → transcribes via whisper-cpp/Groq → summarizes via OpenRouter → ingests into LanceDB | 30min (API) / 1min (watch) | Plaud API or `audio_inbox/` → whisper → LanceDB `audio_transcripts` |
| `ingest-audio.js` | Watches `audio_inbox/` for raw audio → whisper.cpp transcription → Ollama summary → Markdown to `shared_context/audio/` | 60s poll | `audio_inbox/*.mp3` → whisper.cpp → `shared_context/audio/` |
| `screenpipe-sync.js` | Ingests `shared_context/screen/YYYY-MM-DD.md` (written by laptop-side sync) into LanceDB. Tracks byte offset to avoid double-ingestion | 5min | `shared_context/screen/*.md` → LanceDB `screen_activity` |
| `ingest-context.js` | Unified watcher: parses both screen and audio Markdown from `shared_context/` → adds to LanceDB with embeddings | 5min | `shared_context/{screen,audio}/*.md` → LanceDB |
| `sms-reader.js` | Reads macOS Messages `chat.db` → parses Indian bank SMS → stores in SQLite `transactions` table + `sms_inbox.json` for CFO bot | 5min | `~/Library/Messages/chat.db` → `hydra.db` transactions |
| `dashboard.js` | Express server (port 3080) showing per-agent token usage, costs, health status | Always-on | `brain/usage/` JSON → HTTP dashboard |

**Adding a new script**: Create in `scripts/`, add `script('name', './scripts/name.js')` to `ecosystem.config.cjs`. Follow the poll-loop pattern (not cron) — see `screenpipe-sync.js` for the simplest example.

### MCP Server (`mcp/hydra-mcp-server.js`)

Stdio-based MCP server — **not** managed by PM2. Spawned on-demand by external AI clients (e.g., OpenClaw) via:
```sh
openclaw mcp add --name hydra --command "node mcp/hydra-mcp-server.js"
```

Current tools: `hydra_home_control`, `hydra_read_sensors`, `hydra_paper_trade`, `hydra_portfolio`, `hydra_debt_status`, `hydra_search_brain`, `hydra_write_context`, `hydra_agent_status`, `hydra_read_messages`.

**Adding a new MCP tool**:
1. Add tool schema to the `ListToolsRequestSchema` handler's returned `tools` array:
   ```js
   { name: "hydra_new_tool", description: "...", inputSchema: { type: "object", properties: { ... }, required: [...] } }
   ```
2. Add handler in the `CallToolRequestSchema` handler's `if/else` chain:
   ```js
   else if (name === "hydra_new_tool") {
     const { param } = args;
     // ... implementation ...
     return { content: [{ type: "text", text: result }] };
   }
   ```
3. Import any needed `core/` modules at the top of the file. The MCP server has access to all HYDRA core modules.

## Commands

```sh
npm start              # Start all agents via PM2
npm run dev            # Start MVP subset only
npm run stop           # Stop all PM2 processes
pm2 logs <agent-name>  # Tail specific agent logs
pm2 restart 01-edmobot # Restart a single agent
node agents/08-watchtower.js --sweep-now  # Manual health sweep
```

## Conventions

- **ESM only** — `"type": "module"` in package.json. Use `import`/`export`, never `require` (except `ecosystem.config.cjs` and `newrelic.cjs`).
- **All LLM calls go through OpenRouter** — the `openai` SDK is configured with `baseURL: 'https://openrouter.ai/api/v1'`. Never call model providers directly.
- **Errors are non-fatal by default** — Redis down, LanceDB search failure, Slack post error → log warning, continue. Only missing env vars (`validateEnv`) are fatal.
- **Agent naming**: `XX-name` for files/PM2, `XX_NAME` for brain namespace. Numbers `00-12` for agents, `99` for gateway.
- **Bus events are fire-and-forget** — always `.catch(() => {})` on `publish()` calls.
- **Atomic writes** — `writeBrain` uses temp file + rename pattern for crash safety.
- **Context injection** — every agent auto-searches LanceDB for relevant screen/audio context using its `contextQuery` from registry. Don't manually wire this; the `Agent.run()` method handles it.
- **Budget awareness** — `checkBudget()` is called before every LLM request. If over budget, the agent returns a blocked message instead of calling the API.
- **Conversation history** — stored in-memory + SQLite `conversation_history` table. `Agent` class manages injection and pruning automatically (configurable via `maxHistoryTurns` in registry).

## Model Preferences

Use the right model for the right job — both for HYDRA agents and for your own AI-assisted development:

**For HYDRA agent config** (in `core/registry.js`):
- **Planning / orchestration / complex reasoning** → `anthropic/claude-opus-4.6` (Tier 1 only, high cost)
- **Coding / tool-heavy work** → `anthropic/claude-sonnet-4.6` with extended thinking (used by edmobot, mercenary)
- **High-context summarization** → `google/gemini-2.5-pro` (200K context, used by cfobot, wolf)
- **Fast cheap tasks** → `google/gemini-2.5-flash` (200K context, lowest cost, used by architect, jarvis)
- **Bulk/optional agents** → `mistralai/mistral-small-3.2-24b-instruct` (cheapest, 24K context, used by brandbot, sahibabot, biobot, auditor)
- **Haiku for speed** → `anthropic/claude-haiku-4.5` (mid-cost, 150K context, used by socialbot)

**For AI-assisted development on this codebase**:
- **Planning, architecture, complex reasoning** → Claude Opus 4.6 — use for designing new agents, refactoring core modules, multi-file changes that need holistic understanding
- **Coding, implementation, debugging** → Claude Sonnet 4.6 with extended thinking — use for writing agent tools, fixing bugs, implementing features, code reviews

Cost rates are defined in `core/bottleneck.js` `MODEL_RATES`. Update there when adding new models.

## Development Workflow

1. **Always test end-to-end before finishing** — never commit untested code. Run the specific agent or script to verify behaviour:
   ```sh
   node agents/XX-name.js                  # Run agent directly (Ctrl+C to stop)
   node scripts/some-script.js --test      # Many scripts support --test flag
   node scripts/sms-reader.js --once       # One-shot mode for scripts
   pm2 restart XX-name && pm2 logs XX-name # Test within PM2
   ```
2. **Commit messages must detail everything** — every commit should have a descriptive message covering all changes made. Use a summary line + bullet list for multi-part changes:
   ```
   feat(XX-name): add tool for <thing>, update prompt, wire cron schedule

   - Add <tool_name> tool with <params> to agents/XX-name.js
   - Update prompts/XX-name.txt with new capability instructions
   - Wire 9AM cron schedule for daily brief
   - Add env vars to core/validate-env.js and sample.env
   ```
   Format: `type(scope): description`. Types: `feat`, `fix`, `chore`, `refactor`, `docs`.
3. **Lint before pushing**: `npm run lint` (ESLint configured for ESM)
4. **Push after every commit** — keep remote in sync. Always `git push origin main` after committing.
