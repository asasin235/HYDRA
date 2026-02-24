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

| #      | Agent           | Model            | Purpose                                                                          | Schedule                                     |
| ------ | --------------- | ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| **00** | `architect`     | Gemini Flash 3   | Chief of Staff: morning/evening briefs, agent watchdog, goal tracking            | 6AM / 10PM daily, watchdog every 30m         |
| **01** | `edmobot`       | Claude Sonnet 4  | Work productivity: Screenpipe context, Jira tickets, work briefs                 | 9AM daily, Friday 5PM weekly perf            |
| **02** | `brandbot`      | DeepSeek V3      | Personal brand: GitHub activity → LinkedIn drafts, lead qualification            | Monday 10AM                                  |
| **03** | `sahibabot`     | Claude Haiku 4.5 | Relationship health: nudges, promise tracking, date suggestions, WhatsApp drafts | 4PM daily nudge, Monday events, 8PM promises |
| **04** | `socialbot`     | Claude Haiku 4.5 | Social proxy: drafts WhatsApp/iMessage/Discord replies via OpenClaw + Screenpipe | Every 2min scan, 9PM daily summary           |
| **05** | `jarvis`        | Claude Haiku 4.5 | Home automation via Home Assistant: AC, lights, geyser, sleep mode, sensors      | Every 30m automation check                   |
| **06** | `cfobot`        | DeepSeek R1      | Personal CFO: SMS spending analysis, debt payoff, wedding fund                   | 11PM nightly, 1st of month projection        |
| **07** | `biobot`        | Claude Haiku 4.5 | Health tracker: Apple Health sync, HRV readiness, quit tracker, streak tracking  | 6AM / 10PM briefs, 3PM walk nudge            |
| **08** | _CareerBot_     | —                | 🔒 Reserved for Phase 2 (career strategy & skill gaps)                           | —                                            |
| **09** | `wolf`          | DeepSeek R1      | Paper trading: Nifty F&O analysis via Perplexity, ₹1L virtual capital            | Weekdays 9:30AM & 3:30PM, Sunday review      |
| **10** | `mercenary`     | Claude Sonnet 4  | Freelance pipeline: lead evaluation, proposal generation, invoicing              | 8PM daily lead scan                          |
| **11** | `auditor`       | Gemini Flash 3   | Weekly reflection: scores all agents, proposes prompt changes, auto-rollback     | Sunday 10PM                                  |
| **99** | `slack-gateway` | —                | Slack Bolt app: message routing, action handlers, `/hydra-status`                | Always-on (Socket Mode)                      |

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

### `core/db.js` — SQLite (better-sqlite3)

- Tables: `agent_state`, `debt_tracker`, `daily_logs`, `paper_trades`, `leads`
- WAL mode with 5s busy timeout
- Stored on Mac Mini internal storage (`~/hydra-brain/brain/hydra.db`)

### `core/memory.js` — Vector Memory (LanceDB, legacy)

- Embedding model: `text-embedding-3-small` (1536 dimensions) via OpenRouter
- Tables: `memories`, `daily_logs`, `reflections`
- Semantic search across agent memories with optional agent filtering
- Stored on Mac Mini internal storage (`~/hydra-brain/lancedb/`)

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

### `core/auth.js` — Inter-Service Auth

- Bearer token authentication for inter-service API calls
- Express middleware (`validateRequest`) and authenticated fetch (`signedFetch`)

### `mcp/hydra-mcp-server.js` 🚧 Sprint 2

- **MCP server** built on `@modelcontextprotocol/sdk` exposing 8 HYDRA tools to OpenClaw's agent
- Register once: `openclaw mcp add --name hydra --command "node /Users/aakif/HYDRA/mcp/hydra-mcp-server.js"`
- Tools: `hydra_home_control`, `hydra_read_sensors`, `hydra_paper_trade`, `hydra_portfolio`, `hydra_debt_status`, `hydra_search_brain`, `hydra_write_context`, `hydra_agent_status`
- Runs as a PM2 process for always-on availability

### `tests/` 🚧 Sprint 2

- Vitest unit tests for all 7 core modules
- Mocked externals (OpenRouter, SQLite, OpenClaw CLI) — fast, offline, deterministic
- Run with `npm test` or `npm run test:watch`

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
│   ├── 08-RESERVED.md         # CareerBot (Phase 2)
│   ├── 09-wolf.js             # Paper trading (Nifty F&O)
│   ├── 10-mercenary.js        # Freelance pipeline
│   ├── 11-auditor.js          # Weekly reflection engine
│   └── 99-slack-gateway.js    # Slack Bolt gateway
├── core/                      # Shared infrastructure
│   ├── agent.js               # Base Agent class (retry, shutdown, health, Winston)
│   ├── auth.js                # API key auth
│   ├── bottleneck.js          # Budget & circuit breaker (tiers from registry)
│   ├── db.js                  # SQLite database
│   ├── filesystem.js          # Brain file I/O
│   ├── logger.js              # Winston structured logger factory
│   ├── memory.js              # LanceDB vector memory (legacy)
│   ├── openclaw.js            # OpenClaw Gateway client (retry + gateway cache)
│   ├── openclaw-memory.js     # Shared brain (OpenClaw memory bridge)
│   ├── registry.js            # Centralized agent config registry
│   └── validate-env.js        # Per-agent env var validation
├── mcp/                       # 🚧 Sprint 2 — MCP server
│   ├── hydra-mcp-server.js    # MCP stdio server exposing 8 HYDRA tools to OpenClaw
│   └── package.json
├── tests/                     # 🚧 Sprint 2 — Vitest unit tests
│   ├── registry.test.js
│   ├── logger.test.js
│   ├── validate-env.test.js
│   ├── bottleneck.test.js
│   ├── agent.test.js
│   ├── filesystem.test.js
│   └── openclaw.test.js
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
│   └── 11-auditor.txt        # Weekly reflection orchestrator persona
├── scripts/                   # Utilities & syncs
│   ├── backup.sh              # Encrypted B2 backup via rclone
│   ├── restore.sh             # Restore from B2 backup
│   ├── cleanup.js             # Daily file cleanup & log rotation
│   ├── health-sync.js         # Apple Health CSV → JSON
│   ├── ingest-audio.js        # Audio → local whisper.cpp + Ollama → shared brain
│   ├── plaud-sync.js          # Plaud API → whisper.cpp → Claude → Drive + audio_inbox
│   ├── setup-whisper.sh       # whisper.cpp + model installer (Apple Silicon Metal)
│   └── screenpipe-sync.js     # Screenpipe OCR → JSON (Mac Mini local)
├── hydra-screenpipe-sync/     # Laptop-side Screenpipe daemon
│   ├── sync.js                # Ollama summarizer + SSH sync
│   ├── package.json
│   ├── .env.example
│   └── README.md
├── docs/                      # Extended documentation
│   └── openclaw-guide.md      # OpenClaw setup & usage (full guide)
├── .eslintrc.cjs              # ESLint config for Node.js ESM
├── jsconfig.json              # Editor type checking (checkJs)
├── vitest.config.js           # 🚧 Sprint 2 — Vitest config
├── ecosystem.config.cjs       # PM2 process manager config
├── package.json
├── sample.env                 # Full env var reference
├── .env.example               # Minimal env template
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

| Variable               | Required  | Description                                                |
| ---------------------- | --------- | ---------------------------------------------------------- |
| `OPENROUTER_API_KEY`   | ✅        | OpenRouter API key for all LLM calls                       |
| `SLACK_BOT_TOKEN`      | ✅        | Slack Bot User OAuth Token (`xoxb-...`)                    |
| `SLACK_SIGNING_SECRET` | ✅        | Slack app signing secret                                   |
| `SLACK_APP_TOKEN`      | ✅        | Slack App-Level Token for Socket Mode (`xapp-...`)         |
| `BRAIN_PATH`           | ✅        | Path to brain directory on Mac Mini (e.g. `~/hydra-brain`) |
| `EXTERNAL_SSD_PATH`    | 🔶        | Path to external SSD (e.g. `/Volumes/HydraSSD`)            |
| `HOME_ASSISTANT_URL`   | ✅ jarvis | Home Assistant instance URL                                |
| `HOME_ASSISTANT_TOKEN` | ✅ jarvis | Home Assistant long-lived access token                     |
| `INTERNAL_API_KEY`     | ✅        | Shared key for inter-service communication                 |
| `B2_ACCOUNT_ID`        | 🔶        | Backblaze B2 account ID (backup only)                      |
| `B2_APP_KEY`           | 🔶        | Backblaze B2 application key (backup only)                 |
| `B2_BUCKET`            | 🔶        | B2 bucket name (default: `hydra-backup`)                   |

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

# Unit tests (Vitest — 🚧 Sprint 2)
npm test              # single run
npm run test:watch    # watch mode

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
# Encrypted backup to Backblaze B2 via rclone
./scripts/backup.sh
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

### MCP Server (Sprint 2 🚧)

Once `mcp/hydra-mcp-server.js` is built, register it with OpenClaw once:

```bash
openclaw mcp add --name hydra --command "node /Users/aakif/HYDRA/mcp/hydra-mcp-server.js"
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

### 🚧 Sprint 2 — Tests, MCP, Audio

- [ ] Vitest unit tests for all core modules
- [ ] HYDRA MCP server (`mcp/hydra-mcp-server.js`) — 8 tools for OpenClaw
- [x] Plaud API → whisper.cpp → Claude → Google Drive pipeline (`plaud-sync.js`)
- [x] Local-only ingest-audio (whisper.cpp + Ollama, no OpenRouter)
- [x] whisper.cpp setup script with Apple Silicon Metal support
- [ ] OpenClaw memory enhancements (`writeAgentDecision`, `getContextForAgent`)
- [ ] Context injection into Architect, CFO, BioBot LLM calls

### 📋 Backlog

- [ ] `08-careerbot` — Career strategy & skill gaps
- [ ] Dashboard — Web UI for HYDRA status, logs, and controls
- [ ] Real NSE API — Live market data for Wolf
- [ ] SMS Automation — Auto-scrape transaction SMS for CFOBot

---

## 🛠️ Tech Stack

| Layer           | Technology                                                                          |
| --------------- | ----------------------------------------------------------------------------------- |
| Runtime         | Node.js ≥ 22 (ESM)                                                                  |
| Host            | Mac Mini (all agents run locally)                                                   |
| LLM Gateway     | OpenRouter (Gemini Flash 3, Claude Sonnet 4, DeepSeek R1, Mistral Small, Haiku 4.5) |
| Process Manager | PM2                                                                                 |
| Database        | better-sqlite3 (WAL mode)                                                           |
| Vector Store    | LanceDB                                                                             |
| Embeddings      | text-embedding-3-small (1536d) via OpenRouter                                       |
| Chat Interface  | Slack Bolt (Socket Mode)                                                            |
| Home Automation | Home Assistant REST API                                                             |
| Market Research | Perplexity API (Sonar)                                                              |
| Messaging       | OpenClaw Gateway (WhatsApp, iMessage, Discord, Telegram)                            |
| MCP Server      | @modelcontextprotocol/sdk (🚧 Sprint 2)                                             |
| Transcription   | whisper.cpp local (Apple Silicon Metal GPU)                                         |
| Plaud Sync      | Plaud REST API → Claude Sonnet → Google Drive                                       |
| Local Summary   | Ollama (gemma3:4b) for offline summarization in ingest-audio                        |
| Backup          | rclone + Backblaze B2 (encrypted)                                                   |
| Logging         | Winston (JSON in PM2, pretty-print in dev)                                          |
| Linting         | ESLint (Node.js ESM flat config)                                                    |
| Testing         | Vitest (🚧 Sprint 2)                                                                |
| Brain Storage   | Mac Mini internal SSD                                                               |
| Heavy Data      | External SSD / Google Drive                                                         |

---

## 📄 License

MIT

---

<p align="center">
  <em>Built with obsession by Aatif Rashid — because managing life shouldn't require a second brain, just a better one.</em>
</p>
