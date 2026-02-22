# 🐉 HYDRA — Personal AI Operating System

> **H**yper **Y**ielding **D**ecision & **R**esource **A**gent

A multi-agent AI system that manages your entire life — from work productivity and finances to health, relationships, home automation, investments, and freelance income. Built on Node.js, powered by multiple LLMs via OpenRouter, orchestrated through Slack, running on a Mac Mini with an external SSD for heavy data.

---

## 📐 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SLACK WORKSPACE                          │
│   #00-architect  #01-edmobot  #05-jarvis  #06-cfobot  ...      │
└────────────────────────────┬────────────────────────────────────┘
                             │ Socket Mode
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   99-slack-gateway (Bolt)                        │
│   Routes @hydra <agent> <msg> → Agent.run()                     │
│   Handles approve/reject buttons, /hydra-status command         │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐     ┌──────────────┐
│  core/agent  │   │  core/db     │     │ core/memory  │
│  (OpenRouter │   │  (SQLite)    │     │  (LanceDB)   │
│   LLM calls) │   │              │     │  Vector      │
│  Tool calls  │   │ agent_state  │     │  Search      │
│  Budget check│   │ debt_tracker │     │              │
│  Heartbeat   │   │ daily_logs   │     │  memories    │
└──────┬───────┘   │ paper_trades │     │  daily_logs  │
       │           │ leads        │     │  reflections │
       │           └──────┬───────┘     └──────┬───────┘
       │                  │                    │
       └──────────────────┼────────────────────┘
                          │
         ┌────────────────┼────────────────────┐
         ▼                                     ▼
┌──────────────────────┐         ┌──────────────────────┐
│  Mac Mini Internal   │         │   External SSD       │
│  ~/hydra-brain/      │         │   /Volumes/HydraSSD/ │
│                      │         │                      │
│  brain/              │         │  audio_inbox/        │
│  ├── 00_ARCHITECT/   │         │  backups/            │
│  ├── 01_EDMO/        │         │  media/              │
│  ├── 03_SAHIBA/      │         │  archives/           │
│  ├── 04_SOCIAL/      │         └──────────────────────┘
│  ├── 06_CFO/         │
│  ├── 07_BIOBOT/      │
│  ├── 09_WOLF/        │
│  ├── 10_MERCENARY/   │
│  ├── 11_AUDITOR/     │
│  ├── usage/          │
│  └── hydra.db        │
│  lancedb/            │
└──────────────────────┘
```

---

## 🤖 Agent Registry

| #      | Agent           | Model                     | Purpose                                                                             | Schedule                                     |
| ------ | --------------- | ------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| **00** | `architect`     | Gemini Flash 3            | Meta-strategist: morning/evening briefs, agent watchdog, goal tracking              | 6AM / 10PM daily, watchdog every 30m         |
| **01** | `edmobot`       | Claude Sonnet 4           | Work productivity: Screenpipe context, Jira tickets, work briefs                    | 9AM daily, Friday 5PM weekly perf            |
| **02** | `brandbot`      | Mistral Small             | Personal brand: GitHub activity → LinkedIn drafts, lead qualification               | Monday 10AM                                  |
| **03** | `sahibabot`     | Mistral Small + Haiku 4.5 | Relationship health: nudges, promise tracking, WhatsApp drafts                      | 4PM daily nudge, Monday events, 8PM promises |
| **04** | `socialbot`     | Claude Haiku 4.5          | Social proxy: drafts WhatsApp/iMessage/Discord replies via Screenpipe + AppleScript | Every 2min scan, 9PM daily summary           |
| **05** | `jarvis`        | Gemini Flash 3            | Home automation via Home Assistant: AC, lights, sleep mode, sensors                 | Every 30m automation check                   |
| **06** | `cfobot`        | DeepSeek R1               | Personal CFO: SMS spending analysis, debt payoff, wedding fund                      | 11PM nightly, 1st of month projection        |
| **07** | `biobot`        | Gemini Flash 3            | Health tracker: Apple Health sync, HRV readiness, streak tracking                   | 6AM / 10PM briefs, 3PM walk nudge            |
| **08** | _CareerBot_     | —                         | 🔒 Reserved for Phase 2 (career strategy & skill gaps)                              | —                                            |
| **09** | `wolf`          | DeepSeek R1               | Paper trading: Nifty stock analysis via Perplexity, ₹1L virtual capital             | Weekdays 9:30AM & 3:30PM, Sunday review      |
| **10** | `mercenary`     | Claude Sonnet 4           | Freelance pipeline: lead evaluation, proposal generation, invoicing                 | 8PM daily lead scan                          |
| **11** | `auditor`       | Gemini Flash 3            | Weekly reflection: scores all agents, proposes prompt changes, auto-rollback        | Sunday 10PM                                  |
| **99** | `slack-gateway` | —                         | Slack Bolt app: message routing, action handlers, `/hydra-status`                   | Always-on (Socket Mode)                      |

---

## 🧠 Core Modules

### `core/agent.js` — Base Agent Class

- Wraps OpenRouter chat completions API with tool-calling support
- **Budget enforcement**: estimates token usage, checks against per-agent budget via `bottleneck.js`
- **Health endpoint**: shared Express server on port `3002` with `/health` and `/health/:agent`
- **Heartbeat**: writes `heartbeat.json` every 5 minutes to brain storage
- **Interaction logging**: appends daily logs as JSON to the agent's brain namespace

### `core/bottleneck.js` — Budget & Circuit Breaker

- **$50/month** hard budget cap across all agents
- **Priority tiers** for graceful degradation:
  - **Tier 1** (Architect, CFO, Edmo) — runs up to 100% budget
  - **Tier 2** (Sahiba, Bio, Jarvis) — paused at 80% utilization
  - **Tier 3** (Brand, Wolf, Auditor) — paused at 60% utilization
- **Circuit breaker**: 3 failures within 5 minutes → agent disabled, Slack alert sent
- Tracks per-agent daily and monthly token/cost usage in JSON files

### `core/db.js` — SQLite (better-sqlite3)

- Tables: `agent_state`, `debt_tracker`, `daily_logs`, `paper_trades`, `leads`
- WAL mode with 5s busy timeout
- Stored on Mac Mini internal storage (`~/hydra-brain/brain/hydra.db`)

### `core/memory.js` — Vector Memory (LanceDB)

- Embedding model: `text-embedding-3-small` (1536 dimensions) via OpenRouter
- Tables: `memories`, `daily_logs`, `reflections`
- Semantic search across agent memories with optional agent filtering
- Stored on Mac Mini internal storage (`~/hydra-brain/lancedb/`)

### `core/openclaw.js` — Messaging Gateway Client

- Shared client for OpenClaw Gateway — **any agent** can send messages
- Exports: `sendMessage()`, `sendWhatsApp()`, `sendIMessage()`, `sendDiscord()`, `sendTelegram()`
- Also: `getGatewayStatus()`, `getMessages()` for reading recent threads
- Used by: SocialBot (draft replies), SahibaBot (WhatsApp sends), and available to all other agents

### `core/filesystem.js` — Brain File I/O

- Atomic writes (write to `.tmp` then rename)
- Namespaced directories per agent (e.g. `brain/06_CFO/`)
- Append-to-JSON-array pattern for daily logs
- Error logging to `brain/errors/`

### `core/auth.js` — Inter-Service Auth

- Bearer token authentication for inter-service API calls
- Express middleware (`validateRequest`) and authenticated fetch (`signedFetch`)

### `core/validate-env.js` — Startup Validation

- Checks all required environment variables before any agent starts
- Fails fast with clear error messages

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
│   ├── 00-architect.js        # Meta-strategist & watchdog
│   ├── 01-edmobot.js          # Work productivity
│   ├── 02-brandbot.js         # Personal branding
│   ├── 03-sahibabot.js        # Relationship health
│   ├── 04-socialbot.js        # Social proxy (WhatsApp/iMessage/Discord)
│   ├── 05-jarvis.js           # Home automation
│   ├── 06-cfobot.js           # Personal finance
│   ├── 07-biobot.js           # Health & fitness
│   ├── 08-RESERVED.md         # CareerBot (Phase 2)
│   ├── 09-wolf.js             # Paper trading
│   ├── 10-mercenary.js        # Freelance pipeline
│   ├── 11-auditor.js          # Weekly reflection engine
│   └── 99-slack-gateway.js    # Slack Bolt gateway
├── core/                      # Shared infrastructure
│   ├── agent.js               # Base Agent class
│   ├── auth.js                # API key auth
│   ├── bottleneck.js          # Budget & circuit breaker
│   ├── db.js                  # SQLite database
│   ├── filesystem.js          # Brain file I/O
│   ├── memory.js              # LanceDB vector memory
│   ├── openclaw.js            # OpenClaw Gateway client (messaging)
│   └── validate-env.js        # Env var validation
├── prompts/                   # System prompts (hot-reloadable)
│   └── 00-architect.txt       # Example prompt
├── scripts/                   # Utilities & syncs
│   ├── backup.sh              # Encrypted B2 backup via rclone
│   ├── restore.sh             # Restore from B2 backup
│   ├── cleanup.js             # Daily file cleanup & log rotation
│   ├── health-sync.js         # Apple Health CSV → JSON
│   └── screenpipe-sync.js     # Screenpipe OCR → JSON
├── openclaw.example.json      # OpenClaw Gateway config template
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

Copy `sample.env` to `.env` and fill in all required values:

| Variable               | Required | Description                                                |
| ---------------------- | -------- | ---------------------------------------------------------- |
| `OPENROUTER_API_KEY`   | ✅       | OpenRouter API key for all LLM calls                       |
| `SLACK_BOT_TOKEN`      | ✅       | Slack Bot User OAuth Token (`xoxb-...`)                    |
| `SLACK_SIGNING_SECRET` | ✅       | Slack app signing secret                                   |
| `SLACK_APP_TOKEN`      | ✅       | Slack App-Level Token for Socket Mode (`xapp-...`)         |
| `BRAIN_PATH`           | ✅       | Path to brain directory on Mac Mini (e.g. `~/hydra-brain`) |
| `EXTERNAL_SSD_PATH`    | 🔶       | Path to external SSD (e.g. `/Volumes/HydraSSD`)            |
| `HOME_ASSISTANT_URL`   | ✅       | Home Assistant instance URL                                |
| `HOME_ASSISTANT_TOKEN` | ✅       | Home Assistant long-lived access token                     |
| `INTERNAL_API_KEY`     | ✅       | Shared key for inter-service communication                 |
| `B2_ACCOUNT_ID`        | ✅       | Backblaze B2 account ID                                    |
| `B2_APP_KEY`           | ✅       | Backblaze B2 application key                               |
| `B2_BUCKET`            | ✅       | B2 bucket name (default: `hydra-backup`)                   |

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
- **SabihaBot message drafts** — send, edit, or discard drafted WhatsApp messages
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
- **Model cost rates** tracked per-token (Gemini Flash, Claude Sonnet, DeepSeek R1, Mistral Small)
- **Tiered degradation**: lower-priority agents are paused first as budget is consumed
- **Circuit breaker**: 3 consecutive failures within 5 minutes → agent disabled + Slack `@here` alert
- **Monitoring**: `/hydra-status` shows real-time per-agent spend

---

## 🏥 Health & Monitoring

### Agent Health Endpoint

```
GET http://localhost:3002/health          # All agents summary
GET http://localhost:3002/health/:agent   # Individual agent status
```

Returns:

```json
{
  "agent": "05-jarvis",
  "status": "healthy",
  "lastRun": "2026-02-22T15:30:00.000Z",
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
- Excludes `audio_inbox/` to save bandwidth
- Posts completion summary to `#hydra-status`

### Restore

```bash
# Restore from encrypted B2 backup
./scripts/restore.sh
```

### Cleanup (Daily at 2AM)

- Screen context files > 7 days → deleted
- Audio inbox files > 1 day → deleted
- Transcripts > 30 days → deleted
- Daily logs > 90 days → deleted
- Log files > 50MB → rotated

---

## 📱 Companion Scripts

These scripts sync data from local sources into the brain:

### `scripts/health-sync.js`

- Runs at 5:45AM daily
- Parses Apple Health Auto Export CSV files from Downloads/iCloud
- Extracts: HRV, sleep hours, steps, resting HR, active energy
- Writes consolidated JSON to `brain/07_BIOBOT/health_data/`

### `scripts/screenpipe-sync.js`

- Runs every 5 minutes
- Reads Screenpipe SQLite database for OCR captures
- Filters for relevant apps (Cursor, Slack, Jira, Chrome, Terminal, etc.)
- Writes JSON to `brain/01_EDMO/screen_context/`

---

## 🔗 OpenClaw Integration

HYDRA uses [OpenClaw](https://openclaw.ai) as the messaging I/O layer. OpenClaw provides native APIs for WhatsApp, iMessage, Discord, and Telegram — any HYDRA agent can send messages via the shared `core/openclaw.js` client.

### Setup

```bash
# Clone OpenClaw alongside HYDRA
git clone https://github.com/openclaw/openclaw.git ~/openclaw
cd ~/openclaw && npm install

# Copy HYDRA's example config
cp ~/Documents/HYDRA/openclaw.example.json ~/openclaw/openclaw.json
# Edit openclaw.json with your API keys

# Start OpenClaw
npm start
# Scan QR code to link WhatsApp
```

### How It Works

1. **Incoming:** OpenClaw receives WhatsApp/iMessage/Discord messages → forwards to SocialBot webhook (`http://127.0.0.1:3004/social/incoming`)
2. **Drafting:** SocialBot drafts a reply using Claude Haiku + personality prompt → posts to Slack `#04-socialbot`
3. **Approval:** You tap **Send Now** in Slack → HYDRA calls OpenClaw API → message sent natively
4. **Any agent** can send messages: `import { sendWhatsApp } from '../core/openclaw.js'`

---

## 🗺️ Roadmap

- [ ] **Phase 2 Agents**
  - `08-careerbot` — Career strategy, resume tracking, salary benchmarking
- [ ] **Dashboard** — Web UI for HYDRA status, agent logs, and controls
- [ ] **Voice Interface** — Audio commands via Whisper transcription
- [ ] **Real NSE API** — Live market data for Wolf paper trading
- [ ] **SMS Automation** — Auto-scrape transaction SMS for CFOBot

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
| Backup          | rclone + Backblaze B2 (encrypted)                                                   |
| Brain Storage   | Mac Mini internal SSD                                                               |
| Heavy Data      | External SSD                                                                        |

---

## 📄 License

MIT

---

<p align="center">
  <em>Built with obsession by Aatif Rashid — because managing life shouldn't require a second brain, just a better one.</em>
</p>
