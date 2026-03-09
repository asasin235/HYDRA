# 🐉 HYDRA — Personal AI Operating System

> **H**yper **Y**ielding **D**ecision & **R**esource **A**gent

A multi-agent AI system that manages Aatif Rashid's entire life — from work productivity and finances to health, relationships, home automation, investments, and freelance income. Built on Node.js, powered by multiple LLMs via OpenRouter, orchestrated through Slack, running on a Mac Mini with an external SSD for heavy data.

---

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          SLACK WORKSPACE                                │
│   #00-architect  #01-edmobot  #05-jarvis  #06-cfobot  ...              │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │ Socket Mode
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     99-slack-gateway (Bolt)                             │
│   Routes @hydra <agent> <msg> → Agent.run()                             │
│   Handles approve/reject buttons, /hydra-status command                 │
└────────────────┬────────────────────────────────────────────────────────┘
                 │
   ┌─────────────┼──────────────────────┐
   ▼             ▼                      ▼
┌──────────┐  ┌──────────────┐   ┌───────────────────────┐
│core/agent│  │  core/db     │   │  core/openclaw-memory │
│OpenRouter│  │  (SQLite)    │   │  Markdown → OpenClaw  │
│LLM calls │  │              │   │  memory_search        │
│Tool calls│  │ agent_state  │   │                       │
│Retry+Bkof│  │ debt_tracker │   │  shared_context/      │
│Budget chk│  │ daily_logs   │   │  ├─ screen/  ←────────│── MacBook Pro
│Heartbeat │  │ paper_trades │   │  ├─ audio/   ←────────│── Plaud Note Pro
│Winston   │  │ leads        │   │  └─ notes/            │   (via GDrive)
└─────┬────┘  └──────┬───────┘   └──────────────────────┘
      │               │                    ▲
      └───────────────┘                    │ whisper.cpp (local)
              │                            │ + keyword tagging
              │              ┌─────────────┴─────────────────┐
              │              │  scripts/plaud-gdrive-sync     │
              │              │  Google Drive → audio_inbox/   │
              │              │  (chokidar watcher → instant   │
              │              │   transcription via whisper.cpp)│
              │              └─────────────────────────────────┘
              │
              ▼
┌────────────────────────────┐     ┌──────────────────────────────────┐
│  mcp/hydra-mcp-server.js   │     │  OpenClaw Gateway                │
│  (MCP stdio server)        │←────│  (sends/receives messages)       │
│  Tools exposed to OpenClaw:│     │  ← HYDRA MCP registered here    │
│  • hydra_home_control      │     └──────────────────────────────────┘
│  • hydra_read_sensors      │
│  • hydra_paper_trade       │
│  • hydra_portfolio         │
│  • hydra_debt_status       │
│  • hydra_search_brain      │
│  • hydra_write_context     │
│  • hydra_agent_status      │
└────────────────────────────┘
```

---

## 🤖 Agent Registry

| #      | Agent           | Model             | Purpose                                                                          | Schedule                                     |
| ------ | --------------- | ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| **00** | `architect`     | Gemini 2.5 Flash  | Chief of Staff: morning/evening briefs, agent watchdog, goal tracking            | 6AM / 10PM daily, watchdog every 30m         |
| **01** | `edmobot`       | Claude Sonnet 4.6 | Work productivity: Jira→GitHub pipeline, auto PR, code fixes, work briefs        | 9AM daily, Friday 5PM weekly perf            |
| **02** | `brandbot`      | Mistral Small 3.2 | Personal brand: GitHub activity → LinkedIn drafts, lead qualification            | Monday 10AM                                  |
| **03** | `sahibabot`     | Mistral Small 3.2 | Relationship health: nudges, promise tracking, date suggestions, WhatsApp drafts | 4PM daily nudge, Monday events, 8PM promises |
| **04** | `socialbot`     | Claude Haiku 4.5  | Social proxy: drafts WhatsApp/iMessage/Discord replies via OpenClaw + Screenpipe | Every 2min scan, 9PM daily summary           |
| **05** | `jarvis`        | Gemini 2.5 Flash  | Home automation via Home Assistant: AC, lights, geyser, sleep mode, sensors      | Every 30m automation check                   |
| **06** | `cfobot`        | Gemini 2.5 Pro    | Personal CFO: SMS spending analysis, debt payoff, wedding fund                   | 11PM nightly, 1st of month projection        |
| **07** | `biobot`        | Mistral Small 3.2 | Health tracker: Apple Health sync, HRV readiness, quit tracker, streak tracking  | 6AM / 10PM briefs, 3PM walk nudge            |
| **08** | `watchtower`    | — (no LLM)        | Health monitor & auto-healer: PM2 process health, heartbeat checks, auto-restart | Every 15min sweep                            |
| **09** | `wolf`          | Gemini 2.5 Pro    | Paper trading: Nifty F&O analysis via Perplexity, ₹1L virtual capital            | Weekdays 9:30AM & 3:30PM, Sunday review      |
| **10** | `mercenary`     | Claude Sonnet 4.6 | Freelance pipeline: lead evaluation, proposal generation, invoicing              | 8PM daily lead scan                          |
| **11** | `auditor`       | Mistral Small 3.2 | Weekly reflection: scores all agents, proposes prompt changes, auto-rollback     | Sunday 10PM                                  |
| **12** | `careerbot`     | Claude Sonnet 4.6 | Career strategy: GitHub profile analysis, skill gap scoring, career pulse briefs | Monday 8AM weekly                            |
| **99** | `slack-gateway` | —                 | Slack Bolt app: message routing, action handlers, `/hydra-status`                | Always-on (Socket Mode)                      |

> **Agent config is centralised in `core/registry.js`** — a single source of truth for names, models, namespaces, prompt files, and budget tiers.

---

## 🧠 Core Modules

### `core/registry.js`

- **Single source of truth** for all agent configuration (name, model, namespace, promptFile, budget tier, Slack channel)
- Exports: `AGENTS`, `AGENT_NAMES`, `ACTIVE_AGENT_NAMES`, `TIER1`, `TIER2`, `TIER3`, `AGENT_NAMESPACES`
- Previously duplicated across `00-architect.js`, `11-auditor.js`, and `bottleneck.js` — now all import from here

### `core/agent.js` — Base Agent Class

- Wraps OpenRouter chat completions API with tool-calling support
- **Retry with exponential backoff**: 3 attempts (1s → 2s → 4s) on 429/502/503/timeout errors
- **Budget enforcement**: estimates token usage, checks against per-agent budget via `bottleneck.js`
- **Graceful shutdown**: SIGTERM/SIGINT handlers clear heartbeat intervals and close health server cleanly
- **Health endpoint**: shared Express server on port `3002` with `/health` and `/health/:agent` — returns **real circuit-breaker and paused state**
- **Heartbeat**: writes `heartbeat.json` every 5 minutes to brain storage
- **Interaction logging**: appends daily logs as JSON to the agent's brain namespace
- **Winston logging**: structured logs with JSON mode in PM2, pretty-print in dev

### `core/logger.js`

- Winston-based structured logger factory: `createLogger('agent-name')`
- Auto-detects PM2 environment — JSON output in production, colour-coded pretty-print in dev
- Log levels: `debug`, `info`, `warn`, `error`
- All agents get their own named logger instance via `this.log`

### `core/bottleneck.js` — Budget & Circuit Breaker

- **$50/month** hard budget cap across all agents
- **Priority tiers** sourced from `core/registry.js`:
  - **Tier 1** (Architect, CFO, Edmo) — runs up to 100% budget
  - **Tier 2** (Sahiba, Bio, Jarvis, Social) — paused at 80% utilization
  - **Tier 3** (Brand, Wolf, Auditor, Mercenary) — paused at 60% utilization
- **Circuit breaker**: 3 failures within 5 minutes → agent disabled, Slack alert sent
- Tracks per-agent daily and monthly token/cost usage in JSON files

### `core/bus.js` — Redis Event Bus

- Redis pub/sub via `ioredis` for inter-agent communication
- Channels: `hydra:agent.run`, `hydra:agent.error`, `hydra:health.alert`, `hydra:budget.warning`, `hydra:market.signal`
- New Relic distributed trace propagation across bus events
- All errors non-fatal — agents continue normally if Redis is down

### `core/db.js` — SQLite (better-sqlite3)

- Tables: `agent_state`, `debt_tracker`, `daily_logs`, `paper_trades`, `leads`, `transactions`, `conversation_history`
- WAL mode with 5s busy timeout
- Stored on Mac Mini internal storage (`~/hydra-brain/brain/hydra.db`)

### `core/memory.js` — Vector Memory (LanceDB + RuVector)

- Embedding model: `text-embedding-3-small` (1536 dimensions) via OpenRouter
- Tables: `memories`, `daily_logs`, `reflections`, `screen_activity`, `audio_transcripts`, `context_feed`
- Semantic search across all context sources — screen captures, audio transcripts, agent memories
- `searchScreenContext(query)` — finds screen activity relevant to a query (used by all agents)
- `searchAllContext(query)` — unified cross-source search (screen + audio + memories)
- `addScreenActivity()` / `addAudioTranscript()` — called by `scripts/ingest-context.js`
- Each agent auto-searches for context using its `contextQuery` from `core/registry.js`
- **RuVector integration**: optional dual-write, shadow reads, and metrics controlled by env flags
- Stored at `BRAIN_PATH/lancedb/` (LanceDB) and `BRAIN_PATH/ruvector/` (RuVector)

### `core/openclaw.js` — Messaging Gateway Client

- Uses the **OpenClaw CLI** (`openclaw message send`, etc.) via `child_process.execFile`
- **Retry logic**: 2 attempts with 500ms/1s backoff for transient CLI failures
- **Gateway caching**: `isGatewayAvailable()` caches `openclaw health` result for 60s
- Cache is invalidated on send failures so a downed gateway is detected quickly
- Exports: `sendMessage()`, `sendWhatsApp()`, `sendIMessage()`, `sendDiscord()`, `sendTelegram()`
- Also: `getGatewayStatus()`, `getChannelStatus()`, `getMessages()`, `isGatewayAvailable()`

### `core/openclaw-memory.js` — Shared Brain (OpenClaw Memory)

- Writes context as Markdown files to `~/hydra-brain/shared_context/` (auto-indexed by OpenClaw)
- Three data streams: `screen/` (Screenpipe), `audio/` (Plaud Note), `notes/` (agent observations)
- Exports: `writeScreenActivity()`, `writeAudioTranscript()`, `writeContext()`, `searchContext()`
- Also: `readTodayScreenActivity()`, `readRecentContext()`

### `core/github.js` — GitHub API (Dual Account)

- Supports two GitHub accounts: **personal** (`GITHUB_TOKEN`) and **work** (`GITHUB_WORK_TOKEN`)
- EdmoBot defaults to work account; BrandBot uses personal account
- Operations: `getRepo()`, `listFiles()`, `getFileContent()`, `updateFile()`, `createBranch()`, `createPR()`, `searchCode()`
- All functions accept optional `account` parameter: `'personal'` or `'work'`

### `core/jira.js` — Jira Cloud API

- Full Jira REST API v3 integration with Basic Auth (email + API token)
- `getMyTickets()` — fetch assigned tickets filtered by status
- `getTicketDetails(key)` — full issue details with ADF→text description parsing
- `transitionTicket(key, status)` — move ticket through workflow (To Do → In Progress → Done)
- `addJiraComment(key, text)` — add comments to tickets
- `createJiraIssue()` — create new issues with ADF-formatted descriptions

### `scripts/ingest-context.js` — Context Ingestion Service (PM2)

- Watches `shared_context/screen/*.md` and `audio/*.md` for new entries
- Parses Markdown into structured entries (timestamp, source, apps, summary)
- Writes each entry to LanceDB via `core/memory.js` with vector embeddings
- Polls every 5 minutes, tracks ingestion state to avoid duplicates
- Feeds the semantic search that all agents use for context

### `core/validate-env.js` — Per-Agent Startup Validation

- **Per-agent validation**: each agent only checks the env vars it actually needs
  - `validateEnv('05-jarvis')` → checks `OPENROUTER_API_KEY` + `BRAIN_PATH` + HA vars only
  - `validateEnv()` → checks core vars only
- Allows running a single agent without needing all unrelated keys (e.g. B2, GitHub)
- Fails fast with clear messages listing every missing variable and which agent needs it

### `core/filesystem.js` — Brain File I/O

- Atomic writes (write to `.tmp` then rename)
- Namespaced directories per agent (e.g. `brain/06_CFO/`)
- Append-to-JSON-array pattern for daily logs
- Error logging to `brain/errors/`

### `core/health-server.js` — Dedicated Health Server

- Standalone Express server (port 3002) — runs as its own PM2 process
- Agents report status via `POST /health/report`; external queries via `GET /health/:agent`
- Returns real circuit-breaker and paused state from `core/bottleneck.js`
- Solves the port-collision issue of embedding health in each agent process

### `core/nr-instrument.js` — New Relic Instrumentation

- Safe wrappers: `withTransaction()`, `recordEvent()`, `recordMetric()`, `noticeError()`, `addAttributes()`
- Distributed trace propagation via `insertTraceHeaders()` / `acceptTraceHeaders()`
- No-ops if New Relic agent is not loaded — zero overhead when disabled

### `core/hermes-bridge.js` — Hermes Messaging Gateway

- Unified messaging API via the Hermes CLI binary (`hermes message send`)
- WhatsApp, Telegram, Discord, Slack bridges
- Retry logic: 2 attempts with 500ms/1s backoff for transient CLI failures
- Replaces OpenClaw for outbound messaging; OpenClaw retained for MCP tools only

### `core/auth.js` — Inter-Service Auth

- Bearer token authentication for inter-service API calls
- Express middleware (`validateRequest`) and authenticated fetch (`signedFetch`)

### `mcp/hydra-mcp-server.js`

- **MCP server** built on `@modelcontextprotocol/sdk` exposing 9 HYDRA tools to external AI clients
- Register once: `openclaw mcp add --name hydra --command "node mcp/hydra-mcp-server.js"`
- Tools: `hydra_home_control`, `hydra_read_sensors`, `hydra_paper_trade`, `hydra_portfolio`, `hydra_debt_status`, `hydra_search_brain`, `hydra_write_context`, `hydra_agent_status`, `hydra_read_messages`
- Runs as a standard stdio process — **not** managed by PM2

---

## 💾 Storage Architecture

### Mac Mini Internal Storage (`BRAIN_PATH`)

Core data that requires fast I/O — kept on the Mac Mini's internal SSD:

- **SQLite database** (`hydra.db`) — agent state, debt tracker, daily logs, trades, leads
- **LanceDB** — vector embeddings for semantic memory search
- **Agent namespaces** — heartbeats, daily logs, configuration, reflections
- **Usage tracking** — monthly token spend, circuit breaker state

### External SSD (`EXTERNAL_SSD_PATH`)

Bulk/heavy data that doesn't need SSD-speed access:

- **Audio inbox** — voice recordings awaiting transcription
- **Backups** — staging area for B2 encrypted backups
- **Media** — large files, screenshots, exports
- **Archives** — old data moved from brain for long-term retention

---

## 📂 Project Structure

```
HYDRA/
├── agents/                    # Individual agent processes
│   ├── 00-architect.js        # Chief of Staff & watchdog
│   ├── 01-edmobot.js          # Work productivity (Edmo)
│   ├── 02-brandbot.js         # Personal branding & lead gen
│   ├── 03-sahibabot.js        # Relationship health
│   ├── 04-socialbot.js        # Social proxy (WhatsApp/iMessage/Discord)
│   ├── 05-jarvis.js           # Home automation
│   ├── 06-cfobot.js           # Personal finance
│   ├── 07-biobot.js           # Health & fitness + quit tracking
│   ├── 08-watchtower.js        # Health monitor & auto-healer (no LLM)
│   ├── 09-wolf.js             # Paper trading (Nifty F&O)
│   ├── 10-mercenary.js        # Freelance pipeline
│   ├── 11-auditor.js          # Weekly reflection engine
│   ├── 12-careerbot.js        # Career strategy & skill gaps
│   └── 99-slack-gateway.js    # Slack Bolt gateway
├── core/                      # Shared infrastructure
│   ├── agent.js               # Base Agent class (retry, shutdown, health, Winston)
│   ├── auth.js                # API key auth
│   ├── bottleneck.js          # Budget & circuit breaker (tiers from registry)
│   ├── bus.js                 # Redis pub/sub event bus
│   ├── db.js                  # SQLite database
│   ├── filesystem.js          # Brain file I/O
│   ├── health-server.js       # Dedicated health endpoint server (port 3002)
│   ├── hermes-bridge.js       # Hermes messaging gateway (WhatsApp, Telegram, Discord)
│   ├── logger.js              # Winston structured logger factory
│   ├── memory.js              # LanceDB vector memory + RuVector integration
│   ├── ruvectorStore.js       # RuVector adapter (init, upsert, search)
│   ├── nr-instrument.js       # New Relic custom instrumentation wrappers
│   ├── openclaw.js            # OpenClaw Gateway client (MCP only now)
│   ├── openclaw-memory.js     # Shared brain (Markdown context writer)
│   ├── registry.js            # Centralized agent config registry
│   └── validate-env.js        # Per-agent env var validation
├── mcp/                       # MCP server
│   ├── hydra-mcp-server.js    # MCP stdio server exposing 9 HYDRA tools
│   └── package.json
├── prompts/                   # System prompts (hot-reloadable)
│   ├── 00-architect.txt       # Chief of Staff persona
│   ├── 01-edmobot.txt         # Senior Backend Engineer persona
│   ├── 02-brandbot.txt        # Publicist & lead gen persona
│   ├── 03-sahibabot.txt       # Relationship guardian persona
│   ├── 04-socialbot.txt       # Social proxy persona (Delhi dev tone)
│   ├── 05-jarvis.txt          # Home automation persona
│   ├── 06-cfobot.txt          # Strict financial controller persona
│   ├── 07-biobot.txt          # Health & wellness coach persona
│   ├── 09-wolf.txt            # Conservative F&O risk analyst persona
│   ├── 10-mercenary.txt       # Ruthless freelance contractor persona
│   ├── 11-auditor.txt         # Weekly reflection orchestrator persona
│   └── 12-careerbot.txt       # Career strategy advisor persona
├── scripts/                   # Utilities & syncs
│   ├── backup.sh              # Encrypted B2 backup via rclone
│   ├── restore.sh             # Restore from B2 backup
│   ├── cleanup.js             # Daily file cleanup & log rotation
│   ├── health-sync.js         # Apple Health CSV → JSON
│   ├── dashboard.js           # Token usage dashboard (Express, port 3080)
│   ├── health-sync.js         # Apple Health CSV → JSON
│   ├── ingest-audio.js        # Audio → local whisper.cpp + Ollama → shared brain
│   ├── ingest-context.js      # Unified screen+audio → LanceDB ingestion
│   ├── plaud-sync.js          # Plaud API → whisper.cpp → OpenRouter → LanceDB
│   ├── screenpipe-sync.js     # Screenpipe OCR → LanceDB (Mac Mini local)
│   ├── backfill-lancedb-to-ruvector.js  # Phase 1: one-time LanceDB→RuVector copy
│   ├── replay-ruvector-retry-queue.js   # Replay failed RuVector writes
│   ├── setup-whisper.sh       # whisper.cpp + model installer (Apple Silicon Metal)
│   └── sms-reader.js          # macOS Messages → bank SMS → SQLite transactions
├── hydra-screenpipe-sync/     # Laptop-side Screenpipe daemon
│   ├── sync.js                # Ollama summarizer + SSH sync
│   ├── package.json
│   ├── .env.example
│   └── README.md
├── docs/                      # Extended documentation
│   ├── openclaw-guide.md      # OpenClaw setup & usage (full guide)
│   └── verification-ruvector-integration.md  # RuVector testing steps
├── tests/                     # Vitest tests
│   ├── setup.js               # Global test setup
│   ├── smoke.test.js          # Module import smoke tests
│   └── core/                  # Unit tests for core modules
│       ├── registry.test.js
│       └── ruvectorStore.test.js
├── .github/
│   └── copilot-instructions.md  # AI coding agent instructions
├── docker/
│   └── observability/         # Prometheus + Grafana stack
├── jsconfig.json              # Editor type checking (checkJs)
├── newrelic.cjs               # New Relic agent config
├── ecosystem.config.cjs       # PM2 process manager config
├── package.json
├── sample.env                 # Full env var reference
└── .gitignore
```

---

## 🚀 Getting Started

### Prerequisites

- **Mac Mini** (primary host for all agents)
- **Node.js** ≥ 22.0.0
- **PM2** (installed as dependency, or globally: `npm i -g pm2`)
- **External SSD** connected to Mac Mini (for heavy data storage)
- **Slack workspace** with a Bolt app configured for Socket Mode
- **OpenRouter API key** for LLM access

### Installation

```bash
# Clone the repository
git clone https://github.com/asasin235/HYDRA.git
cd HYDRA

# Install dependencies
npm install

# Copy and configure environment variables
cp sample.env .env
# Edit .env with your API keys, tokens, and paths

# Create brain directory
mkdir -p ~/hydra-brain/brain
```

### Configuration

Copy `sample.env` to `.env` and fill in all required values.

> **Note:** Each agent now only validates the env vars it needs. You can run a single agent (e.g. `05-jarvis`) without setting up B2 backup keys, GitHub tokens, or Perplexity.

| Variable                      | Required   | Description                                                |
| ----------------------------- | ---------- | ---------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | ✅         | OpenRouter API key for all LLM calls                       |
| `SLACK_BOT_TOKEN`             | ✅         | Slack Bot User OAuth Token (`xoxb-...`)                    |
| `SLACK_SIGNING_SECRET`        | ✅         | Slack app signing secret                                   |
| `SLACK_APP_TOKEN`             | ✅         | Slack App-Level Token for Socket Mode (`xapp-...`)         |
| `BRAIN_PATH`                  | ✅         | Path to brain directory on Mac Mini (e.g. `~/hydra-brain`) |
| `EXTERNAL_SSD_PATH`           | 🔶         | Path to external SSD (e.g. `/Volumes/HydraSSD`)            |
| `HOME_ASSISTANT_URL`          | ✅ jarvis  | Home Assistant instance URL                                |
| `HOME_ASSISTANT_TOKEN`        | ✅ jarvis  | Home Assistant long-lived access token                     |
| `INTERNAL_API_KEY`            | ✅         | Shared key for inter-service communication                 |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | 🔶         | Path to Google SA JSON file (backup/sync)                  |
| `GOOGLE_DRIVE_FOLDER_ID`      | 🔶         | Google Drive Folder ID for backups/sync                    |
| `GITHUB_WORK_TOKEN`           | ✅ edmobot | Work GitHub PAT (Edmo) for PR creation                     |
| `GITHUB_WORK_USERNAME`        | ✅ edmobot | Work GitHub username                                       |
| `GITHUB_WORK_ORG`             | 🔶 edmobot | Work GitHub org name (if applicable)                       |
| `JIRA_BASE_URL`               | ✅ edmobot | Jira Cloud URL (e.g. `https://edmo.atlassian.net`)         |
| `JIRA_EMAIL`                  | ✅ edmobot | Jira account email                                         |
| `JIRA_API_TOKEN`              | ✅ edmobot | Jira API token (from id.atlassian.com)                     |
| `JIRA_PROJECT_KEY`            | ✅ edmobot | Default Jira project key (e.g. `EDMO`)                     |

See `sample.env` for the full list including optional variables for each agent.

### Running

```bash
# Start all agents
npm start
# → pm2 start ecosystem.config.cjs

# Start MVP subset (Architect + CFO + Jarvis + Gateway)
npm run dev
# → pm2 start ecosystem.config.cjs --only start-mvp

# Or start specific agents
pm2 start ecosystem.config.cjs --only 00-architect,06-cfobot,05-jarvis,99-slack-gateway

# Monitor
npm run logs      # pm2 logs
npm run status    # pm2 status

# Stop all
npm run stop      # pm2 stop all
```

### Developer Setup

```bash
# Lint (ESLint with Node.js ESM config)
npm run lint
npm run lint:fix

# Unit tests (Vitest)
npm test              # single run
npm run test:watch    # watch mode
npm run test:ci       # run with coverage
npm run coverage      # alias for test:ci

# Editor type checking: open in VS Code or Cursor
# jsconfig.json enables checkJs for all core/ agents/ scripts/
```

---

## 💬 Slack Interface

### Messaging Agents

```
@hydra jarvis turn off AC
@hydra cfobot how much did I spend today?
@hydra sahibabot draft goodnight message
@hydra wolf portfolio summary
@hydra mercenary scan leads
```

### Slash Commands

```
/hydra-status    # Shows PM2 process status, token spend, debt tracker
```

### Interactive Actions

- **Reflection approve/skip buttons** — approve or skip prompt changes proposed by the auditor
- **SahibaBot message drafts** — send, edit, or discard drafted WhatsApp messages
- **SocialBot draft reviews** — Send Now / Edit / Discard for auto-drafted chat replies
- **Approve/reject actions** — general-purpose agent action approvals

---

## 🔄 Self-Improvement Loop (Auditor)

Every Sunday at 10PM, `11-auditor` orchestrates a reflection cycle:

1. **Reads** the past 7 days of logs for each agent
2. **Scores** performance (1–10) using Gemini Flash
3. **Identifies** top 2 failures and proposes specific prompt changes
4. **Posts** results to Slack with approve/skip buttons
5. **On approval**: applies prompt changes, git commits, and reloads the agent
6. **Auto-rollback**: if score drops > 2 points from last week, reverts the last git commit automatically

---

## 💰 Budget Management

- **Monthly cap**: $50 across all agents
- **Model cost rates** tracked per-token
- **Tiered degradation** (from `core/registry.js`):
  - Tier 1 (Architect, CFO, Edmo) — always runs
  - Tier 2 (Sahiba, Bio, Jarvis, Social) — paused at 80%
  - Tier 3 (Brand, Wolf, Auditor, Mercenary) — paused at 60%
- **Circuit breaker**: 3 consecutive failures within 5 minutes → agent disabled + Slack `@here` alert
- **Retry**: LLM calls retry up to 3× with exponential backoff before tripping the circuit breaker
- **Monitoring**: `/hydra-status` shows real-time per-agent spend

---

## 🏥 Health & Monitoring

### Agent Health Endpoint

```
GET http://localhost:3002/health          # All agents summary
GET http://localhost:3002/health/:agent   # Individual agent status
```

Returns **real** agent state (not hardcoded "healthy"):

```json
{
  "agent": "05-jarvis",
  "status": "healthy", // "healthy" | "paused" | "circuit-open"
  "lastRun": "2026-02-24T00:30:00.000Z",
  "tokensTodayUsed": 1234,
  "tokensTodayBudget": 100000,
  "circuitBreaker": "closed",
  "uptime": 86400
}
```

### Watchdog

The Architect agent checks heartbeats every 30 minutes. If any online agent hasn't written a heartbeat in 15+ minutes, it posts a ⚠️ alert to Slack.

---

## 💾 Backup & Recovery

### Automated Backup

```bash
# Backup to Google Drive via rclone
./scripts/backup-gdrive.sh
```

- Uses `rclone crypt` for at-rest encryption
- Posts completion summary to `#hydra-status`

### Restore

```bash
./scripts/restore.sh
```

### Cleanup (Daily at 2AM)

- Screen context files > 7 days → deleted
- Audio inbox files > 1 day → deleted
- Transcripts > 30 days → deleted
- Daily logs > 90 days → deleted
- Log files > 50MB → rotated

---

## 🔗 OpenClaw Integration

HYDRA uses [OpenClaw](https://docs.openclaw.ai) as the messaging I/O layer. OpenClaw provides a self-hosted gateway for WhatsApp, iMessage, Discord, Telegram, and more.

See **[docs/openclaw-guide.md](docs/openclaw-guide.md)** for the full setup guide.

Key notes:

- Outgoing: any agent can call `sendWhatsApp()`, `sendIMessage()`, etc. from `core/openclaw.js`
- Incoming: OpenClaw forwards messages to SocialBot's webhook at `http://127.0.0.1:3004/social/incoming`
- CLI calls include **retry logic** (2 attempts) and a **60-second gateway availability cache**

### MCP Server

Register `mcp/hydra-mcp-server.js` with OpenClaw once:

```bash
openclaw mcp add --name hydra --command "node mcp/hydra-mcp-server.js"
```

After registration, OpenClaw's agent can use HYDRA tools naturally:

```
You: what's the temperature at home?
OpenClaw → calls hydra_read_sensors → Jarvis HA API → "28°C, motion: clear"

You: turn on the AC
OpenClaw → calls hydra_home_control { device: "ac", action: "turn_on" } → "AC on, target 22°C"

You: what's my debt status?
OpenClaw → calls hydra_debt_status → "₹11.2L remaining, ₹1.3L paid (10.4%)"
```

---

## 🔮 RuVector Integration

HYDRA supports [RuVector](https://github.com/ruvnet/ruvector) as a secondary vector store alongside LanceDB, enabling a phased migration.

### Phased Migration

| Phase | Feature        | Env Flag                  | Description                                  |
| ----- | -------------- | ------------------------- | -------------------------------------------- |
| 1     | Backfill       | —                         | One-time copy from LanceDB → RuVector        |
| 2     | Dual-Write     | `RUVECTOR_DUAL_WRITE=1`   | Write to both stores (LanceDB authoritative) |
| 3     | Shadow Reads   | `RUVECTOR_SHADOW_READ=1`  | Parallel searches with metrics               |
| 3+    | Primary Switch | `RUVECTOR_READ_PRIMARY=1` | Return RuVector results instead of LanceDB   |

### Quick Start

```bash
# 1. Run backfill (one-time)
npm run backfill:ruvector

# 2. Enable dual-write in .env
RUVECTOR_ENABLE=1
RUVECTOR_DUAL_WRITE=1

# 3. Enable shadow reads for metrics
RUVECTOR_SHADOW_READ=1

# 4. (Optional) Switch primary reads
RUVECTOR_READ_PRIMARY=1
```

### Dashboard

- **`/ruvector`** — latency comparison charts, overlap metrics, retry queue viewer
- **`/lancedb`** — per-table record counts, storage health, quick search test

### Metrics

Shadow read metrics are logged to `{BRAIN_PATH}/ruvector/metrics.jsonl` with latencies, ID overlap ratios, and error counts for both backends.

See **[docs/verification-ruvector-integration.md](docs/verification-ruvector-integration.md)** for full testing instructions.

---

## 🎙️ Plaud Recording Pipeline

Automated call recording processing: Plaud AI → whisper.cpp → Claude → Google Drive.

### How It Works

1. **`plaud-sync.js`** polls the Plaud REST API every 5 minutes for new recordings
2. Downloads the MP3 via presigned URL
3. Uploads raw MP3 to Google Drive (`/PlaudRecordings/`)
4. Transcribes locally via **whisper.cpp** (Apple Silicon Metal GPU)
5. Sends transcript to **Claude Sonnet** for rich summarization:
   - Meeting summary (5–7 sentences)
   - Key decisions (bullet list)
   - Action items (markdown checklist with owner + deadline)
   - Mind map (Mermaid.js)
   - Top 5 highlights / notable quotes
   - Handles Hinglish (Hindi + English) → always outputs English
6. Drops `.mp3` + `.md` into `audio_inbox/`
7. **`ingest-audio.js`** picks up the files, writes to shared brain context
8. State tracked in `processed_ids.json` — no duplicates across restarts

### Setup: whisper.cpp (Apple Silicon with Metal)

Run the included setup script:

```bash
chmod +x scripts/setup-whisper.sh
bash scripts/setup-whisper.sh
```

This will:

1. Clone `whisper.cpp` to `~/whisper.cpp`
2. Build with **CMake + Metal** (Apple GPU acceleration)
3. Download the `ggml-large-v3-q5_0` quantized model (~1.5 GB)
4. Print the `WHISPER_CPP_PATH` and `WHISPER_MODEL_PATH` to add to your `.env`

**Manual install** (if the script doesn't work):

```bash
# Prerequisites
brew install cmake

# Clone & build
git clone https://github.com/ggerganov/whisper.cpp.git ~/whisper.cpp
cd ~/whisper.cpp && mkdir build && cd build
cmake .. -DWHISPER_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build . --config Release -j $(sysctl -n hw.ncpu)

# Download model
mkdir -p ~/models
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin \
  -o ~/models/ggml-large-v3-q5_0.bin

# Test
~/whisper.cpp/build/bin/whisper-cli -m ~/models/ggml-large-v3-q5_0.bin -f /path/to/test.mp3
```

### Setup: Google Service Account (for Drive uploads)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Drive API** (APIs & Services → Enable)
4. Go to **IAM & Admin → Service Accounts** → Create Service Account
5. Give it a name like `hydra-plaud-sync`
6. Click the new service account → **Keys** tab → **Add Key** → **JSON**
7. Download the JSON key file to `~/hydra-brain/credentials/google-sa.json`
8. In Google Drive, create a folder `/PlaudRecordings/`
9. **Share** the folder with the service account email (found in the JSON, `client_email` field)
10. Copy the folder ID from the URL: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
11. Set env vars:

```env
GOOGLE_SERVICE_ACCOUNT_PATH=~/hydra-brain/credentials/google-sa.json
GOOGLE_DRIVE_FOLDER_ID=your-folder-id
```

### Environment Variables

| Variable                      | Required        | Description                                                   |
| ----------------------------- | --------------- | ------------------------------------------------------------- |
| `PLAUD_API_KEY`               | ✅ plaud-sync   | Plaud API Bearer token                                        |
| `ANTHROPIC_API_KEY`           | ✅ plaud-sync   | Claude Sonnet for summarization                               |
| `WHISPER_CPP_PATH`            | ✅ both         | Path to whisper.cpp binary                                    |
| `WHISPER_MODEL_PATH`          | ✅ both         | Path to ggml model file                                       |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | 🔶 plaud-sync   | SA JSON key (Drive upload skipped without it)                 |
| `GOOGLE_DRIVE_FOLDER_ID`      | 🔶 plaud-sync   | Target Drive folder ID                                        |
| `OLLAMA_MODEL`                | 🔶 ingest-audio | Local model for fallback summarization (default: `gemma3:4b`) |
| `OLLAMA_URL`                  | 🔶 ingest-audio | Ollama API URL (default: `http://localhost:11434`)            |

---

## 🗺️ Roadmap

### ✅ Sprint 1 — Hardening & DX

- [x] Centralized agent registry (`core/registry.js`)
- [x] Winston structured logging (`core/logger.js`)
- [x] LLM retry with exponential backoff
- [x] Graceful SIGTERM/SIGINT shutdown
- [x] Real health endpoint (circuit-breaker aware)
- [x] Per-agent `validateEnv()`
- [x] OpenClaw retry + gateway availability cache
- [x] ESLint + jsconfig.json
- [x] System prompts for all 11 agents (v5.0)

### ✅ Sprint 2 — MCP, Audio, Observability, Pipelines

- [x] HYDRA MCP server (`mcp/hydra-mcp-server.js`) — 9 tools for OpenClaw
- [x] Plaud API → whisper.cpp → OpenRouter summary → LanceDB pipeline (`plaud-sync.js`)
- [x] Local-only ingest-audio (whisper.cpp + Ollama, no OpenRouter)
- [x] whisper.cpp setup script with Apple Silicon Metal support
- [x] Context injection into all agents via `Agent.run()` auto-search
- [x] SMS reader — macOS Messages bank SMS → SQLite transactions (`sms-reader.js`)
- [x] Token usage dashboard (`scripts/dashboard.js`, port 3080) — redesigned with Gemini AI-inspired visual design, sidebar navigation, Chart.js spending charts, log filtering by agent/model, and dedicated System Health section with watchtower monitoring
- [x] 08-watchtower agent — PM2 health monitoring, auto-restart, budget alerts
- [x] 12-careerbot agent — GitHub profile analysis, skill gap scoring
- [x] Redis event bus (`core/bus.js`) for inter-agent communication
- [x] Dedicated health server (`core/health-server.js`, port 3002)
- [x] New Relic APM integration (`core/nr-instrument.js`, `newrelic.cjs`)
- [x] Hermes messaging gateway bridge (`core/hermes-bridge.js`)
- [x] Prometheus + Grafana observability stack (`docker/observability/`)
- [x] AI coding agent instructions (`.github/copilot-instructions.md`)

### 🚧 Sprint 3 — Tests & Enhancements

- [ ] Vitest unit tests for all core modules
- [ ] Real NSE API — Live market data for Wolf
- [ ] Prompt versioning — automated version tracking in `prompts/versions/`
- [x] Dashboard auth improvements
- [ ] Agent-to-agent direct communication via bus

---

## 🛠️ Tech Stack

| Layer           | Technology                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| Runtime         | Node.js ≥ 22 (ESM)                                                                |
| Host            | Mac Mini (all agents run locally)                                                 |
| LLM Gateway     | OpenRouter (Gemini 2.5 Flash/Pro, Claude Sonnet 4.6/Haiku 4.5, Mistral Small 3.2) |
| Process Manager | PM2                                                                               |
| Database        | better-sqlite3 (WAL mode)                                                         |
| Vector Store    | LanceDB + RuVector (phased migration)                                             |
| Embeddings      | text-embedding-3-small (1536d) via OpenRouter                                     |

| Chat Interface | Slack Bolt (Socket Mode) |
| Home Automation | Home Assistant REST API |
| Market Research | Perplexity API (Sonar) |
| Messaging | Hermes Agent Gateway (WhatsApp, Telegram, Discord) + OpenClaw (MCP only) |
| MCP Server | @modelcontextprotocol/sdk + stdio transport |
| Transcription | whisper.cpp local (Apple Silicon Metal GPU) |
| Event Bus | Redis pub/sub via ioredis |
| Observability | New Relic APM + Prometheus + Grafana + GlitchTip/Sentry |
| Plaud Sync | Plaud REST API → whisper.cpp → OpenRouter summary → LanceDB |
| Local Summary | Ollama (gemma3:4b) for offline summarization in ingest-audio |
| Backup | rclone + Google Drive (encrypted) |
| Logging | Winston (JSON in PM2, pretty-print in dev) |
| Linting | ESLint (Node.js ESM flat config) |
| Testing | Vitest + @vitest/coverage-v8 |
| Brain Storage | Mac Mini internal SSD |
| Heavy Data | External SSD / Google Drive |

---

## 📋 Changelog

### 2026-03-08 — Plaud Audio Pipeline Refactor: Correct API Integration & HTTP Ingest Endpoint

**Plaud Sync Improvement**

- **`scripts/plaud-sync.js` refactored** with correct API layer from plaud-pipesync:
  - Fixed critical bug: replaced broken `/file/download/{id}` endpoint (invalid) with **two-step download** (temp-URL → S3 signed URL)
  - Added full pagination support (50-item pages) — previous version silently missed recordings beyond first page
  - Browser-mirrored auth headers: `app-platform: web`, `edit-from: web`, `origin: https://web.plaud.ai`
  - In-memory audio conversion via `fluent-ffmpeg` (16kHz mono PCM WAV) — **zero disk I/O**
  - Switched dedup from JSON file to SQLite `sync_state` table — crash-safe, persists across restarts
  - **POSTs audio + metadata to dashboard's `/api/ingest/audio` endpoint** (transcription now owned by dashboard)
  - Publishes `hydra:audio.ingested` bus event after successful ingest
  - Subscribes to `hydra:plaud.sync.trigger` for on-demand re-sync via dashboard

**New Dashboard Endpoints**

- `POST /api/ingest/audio` — multipart endpoint for transcription + LanceDB ingest
  - Receives WAV buffer + rich Plaud metadata (scene, serialNumber, hasTranscript, hasSummary, externalId)
  - Transcribes (placeholder for whisper-cpp → Groq → OpenAI chain)
  - Writes Markdown summary to `shared_context/audio/YYYY-MM-DD.md`
  - Calls `addAudioTranscript()` from `core/memory.js`
  - Serializes rich metadata into tags JSON
  - Requires `x-api-key` header for auth
- `GET /plaud/files` — lists all non-trash Plaud recordings with full pagination
- `GET /plaud/sync/status` — returns processed file IDs from SQLite `sync_state`
- `POST /plaud/sync` — triggers on-demand sync via bus event (fire-and-forget)
- `DELETE /plaud/sync/state` — clears processed IDs for full re-sync

**Environment Variables (Updated)**

- `HYDRA_API_KEY` — now **required** (added to `CORE_REQUIRED` in `core/validate-env.js`)
  - Generate: `openssl rand -base64 32`
  - Used for `/api/ingest/audio` auth and `/plaud/*` endpoint auth
- `HYDRA_URL` — defaults to `http://localhost:3080`
- `PLAUD_API_DOMAIN` — now defaults to `https://api-apse1.plaud.ai` (Asia-Pacific endpoint)
- Updated `sample.env` with all new variables

**Rich Metadata Handling**

- Plaud recordings now surface: `scene`, `editFrom`, `hasTranscript`, `hasSummary`, `serialNumber`, `keywords`
- Serialized into `tags` JSON field of `audio_transcripts` LanceDB table
- Enables future filtering/querying by Plaud metadata

**Dependencies**

- `fluent-ffmpeg@^2.1.3` already in package.json — used for in-memory audio conversion
- `busboy` — used for multipart form parsing in `/api/ingest/audio` endpoint

**Known Limitations / TODOs**

- Transcription chain in `/api/ingest/audio` is currently a placeholder — whisper-cpp/Groq/OpenAI fallback to be implemented
- Summary generation in `/api/ingest/audio` is a placeholder — OpenRouter summarization to be implemented
- Audio tagging logic (agent routing) not yet implemented in dashboard endpoint

### 2026-03-01 — Observability Stack, CareerBot, Redis Bus, Health Server, Hermes Gateway, AI Copilot Instructions

**New Agents**

- `12-careerbot` — Career strategy advisor: GitHub profile analysis, skill gap scoring, weekly career pulse briefs (Claude Sonnet 4.6)
- `08-watchtower` — Lightweight health monitor & auto-healer: PM2 process health checks, heartbeat staleness, budget velocity, disk space alerts, auto-restart with crash-loop detection (no LLM, zero cost)

**New Core Modules**

- `core/bus.js` — Redis pub/sub event bus (`ioredis`) for inter-agent communication. Channels: `agent.run`, `agent.error`, `health.alert`, `budget.warning`, `market.signal`. Includes New Relic distributed trace propagation.
- `core/health-server.js` — Dedicated Express server (port 3002) for agent health reporting. Agents POST status; external queries via GET. Solves port-collision issue.
- `core/nr-instrument.js` — New Relic custom instrumentation wrappers: `withTransaction()`, `recordEvent()`, `recordMetric()`, `noticeError()`, `addAttributes()`. Safe no-ops if NR not loaded.
- `core/hermes-bridge.js` — Hermes Agent messaging gateway: unified API for WhatsApp, Telegram, Discord, Slack via Hermes CLI binary. Replaces OpenClaw for outbound messaging.
- `newrelic.cjs` — New Relic agent config, loaded via `--require newrelic` in PM2

**New Scripts & Pipelines**

- `scripts/dashboard.js` — HYDRA Dashboard (Express, port 3080) — Gemini AI-inspired glass morphism design with sidebar navigation, Chart.js spending visualizations (doughnut + bar), agent table with health status, filterable/searchable logs, and dedicated System Health section showing watchtower process monitoring, heartbeats, and per-agent memory/CPU/uptime metrics
- `scripts/sms-reader.js` — macOS Messages `chat.db` → Indian bank SMS parsing → SQLite `transactions` table + `sms_inbox.json` for CFO bot
- `scripts/ingest-context.js` — Unified watcher for `shared_context/{screen,audio}/` → LanceDB ingestion with embeddings
- `scripts/screenpipe-sync.js` — Now tracks byte offset per date to avoid double-ingestion into LanceDB

**Infrastructure**

- Prometheus + Grafana observability stack (`docker/observability/`)
- PM2 Prometheus exporter for process metrics
- GlitchTip/Sentry error tracking (optional, via `GLITCHTIP_DSN` env var)
- All agents emit `agent.run` and `agent.error` events to Redis bus
- Each agent run is wrapped in a New Relic background transaction

**MCP Server Updates**

- New tool: `hydra_read_messages` — read recent messages from any Hermes channel/contact
- Total tools now: 9 (was 8)

**Model Changes**

- Jarvis: `anthropic/claude-haiku-4-5` → `google/gemini-2.5-flash` (cheaper, 200K context)
- All models updated to latest versions in `core/bottleneck.js` MODEL_RATES

**Developer Experience**

- `.github/copilot-instructions.md` — AI coding agent instructions covering architecture, patterns, conventions, model preferences, and dev workflow
- `.gitignore` updated: excludes `*.db`, `*.bak`, `.claude/`
- `prompts/versions/` directory for future prompt version tracking
- Channel-based bot routing in Slack gateway (messages in `#XX-agent` route to that agent)
- Agent conversation history persisted to SQLite `conversation_history` table

### 2026-02-26 — Screenpipe Integration + LanceDB Memory + EdmoBot Coding Pipeline

**Screenpipe → HYDRA Pipeline (MacBook Pro → Mac Mini)**

- Screenpipe v0.3.135 installed on MacBook Pro with Apple Vision OCR + local Whisper
- `~/hydra-screenpipe-sync/sync.js` runs on MacBook: fetches screen data every 15min, summarizes via Ollama (mistral-nemo), SSHs markdown to Mac Mini `shared_context/screen/`
- LaunchAgents for both Screenpipe and sync daemon (auto-start on login)
- Passwordless SSH configured (Ed25519 key)

**LanceDB Semantic Memory**

- Completed `core/memory.js` — added `screen_activity`, `audio_transcripts`, `context_feed` tables
- OpenRouter `text-embedding-3-small` embeddings (1536-dim, ~$0.01/month)
- `scripts/ingest-context.js` PM2 service watches shared_context/ and ingests into LanceDB
- Each agent has a `contextQuery` in `registry.js` for role-based semantic search
- Agent base class (`core/agent.js`) auto-searches LanceDB for relevant context per agent role
- CFOBot only sees finance-related captures, BioBot only health-related, etc.

**EdmoBot Autonomous Coding Pipeline**

- Extended `core/jira.js` with full CRUD: `getMyTickets()`, `getTicketDetails()`, `transitionTicket()`, `addJiraComment()`
- Created `core/github.js` with dual account support (personal + Edmo work)
- EdmoBot now has 11 tools: list_my_tickets, get_ticket_details, read_repo_file, list_repo_files, search_repo_code, create_branch, edit_repo_file, create_pull_request, update_ticket_status, comment_on_ticket, draft_jira_issue
- Autonomous pipeline: `@hydra edmobot fix EDMO-123` → reads ticket → finds code → creates branch → fixes → PR → updates Jira → notifies Slack
- Cron: every 2h (weekdays) lists assigned tickets on Slack, 9AM daily brief, Friday 5PM weekly summary

**Model Upgrades**

- EdmoBot: `anthropic/claude-sonnet-4` → `anthropic/claude-sonnet-4.6`
- CFOBot: `deepseek/deepseek-r1` → `google/gemini-2.5-pro`
- Wolf: `deepseek/deepseek-r1` → `google/gemini-2.5-pro`
- Architect: `google/gemini-flash-3` (broken) → `google/gemini-2.5-flash`
- BrandBot/SahibaBot: `mistral/mistral-small` → `mistralai/mistral-small-3.2-24b-instruct`
- BioBot: `google/gemini-2.0-flash-001` → `google/gemini-2.5-flash`
- Mercenary: `anthropic/claude-sonnet-4` → `anthropic/claude-sonnet-4.6`
- Auditor/Jarvis: `google/gemini-2.0-flash-001` → `mistralai/mistral-small-3.2-24b-instruct`
- Updated `core/bottleneck.js` MODEL_RATES for all new models

**Bug Fixes**

- Fixed `google/gemini-flash-3` model ID (doesn't exist on OpenRouter) → `google/gemini-2.5-flash`
- Fixed `mistral/mistral-small` prefix → `mistralai/mistral-small-3.2-24b-instruct`
- Fixed corrupted `03_SAHIBA/heartbeat.json`
- Installed missing `@anthropic-ai/sdk` dependency for plaud-sync
- Rebuilt `better-sqlite3` native module for current Node.js
- Fixed `BRAIN_PATH` mismatch (hydra-brain vs hydra-mind)

---

## 📄 License

MIT

---

<p align="center">
  <em>Built with obsession by Aatif Rashid — because managing life shouldn't require a second brain, just a better one.</em>
</p>
