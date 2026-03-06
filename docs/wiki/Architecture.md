# 🏗️ Architecture

## System Overview

HYDRA is a multi-agent AI operating system where each agent is an independent Node.js process. Agents communicate through Slack (user-facing) and a Redis event bus (internal). All LLM calls route through OpenRouter.

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
              │
              ▼
┌────────────────────────────┐     ┌──────────────────────────────────┐
│  mcp/hydra-mcp-server.js   │     │  OpenClaw Gateway                │
│  (MCP stdio server)        │←────│  (sends/receives messages)       │
│  Tools exposed to OpenClaw │     └──────────────────────────────────┘
└────────────────────────────┘
```

## Key Architectural Decisions

### 1. One Process Per Agent
Each agent runs as a standalone Node.js process managed by PM2. This provides:
- Independent crash recovery (PM2 auto-restarts)
- Clear resource attribution per agent
- Easy enable/disable without affecting other agents

### 2. Centralised Registry (`core/registry.js`)
All agent metadata lives in a single file:
- Model selection
- Budget tier
- Slack channel
- Brain namespace
- LanceDB context query

> **Never hardcode agent metadata** — always import from `core/registry.js`.

### 3. Budget-Aware LLM Calls
Every LLM request flows through `core/bottleneck.js`, which:
- Enforces a **$50/month** hard cap across all agents
- Pauses lower-priority agents at 80% and 60% utilisation
- Trips a circuit breaker after 3 failures in 5 minutes

### 4. Context Injection via LanceDB
Every `Agent.run()` call automatically:
1. Searches LanceDB for relevant screen/audio context using the agent's `contextQuery`
2. Prepends that context to the system prompt
3. This is wired in `core/agent.js` — individual agents don't need to do anything

### 5. Storage Layout

```
$BRAIN_PATH/
├── brain/
│   ├── hydra.db              # SQLite database
│   ├── usage/                # Budget tracking JSON files
│   ├── 00_ARCHITECT/         # Per-agent JSON state
│   ├── 01_EDMO/
│   └── ...
├── lancedb/                  # LanceDB vector tables
└── shared_context/
    ├── screen/               # Daily Markdown from Screenpipe (MacBook → Mac Mini via SSH)
    └── audio/                # Audio transcript Markdown from Plaud/whisper.cpp
```

## Data Flows

### User Message Flow
```
User → Slack → 99-slack-gateway → Agent.run() → OpenRouter LLM → Tool calls → Response → Slack
```

### Context Ingestion Flow
```
MacBook Screenpipe → SSH → shared_context/screen/YYYY-MM-DD.md
Plaud Note → GDrive → audio_inbox/ → whisper.cpp → shared_context/audio/
ingest-context.js → parse Markdown → embed via OpenRouter → LanceDB
```

### Budget Flow
```
Agent.run() → checkBudget() → [blocked if over limit] → LLM call → track cost → persist to brain/usage/
```

### Health Monitoring Flow
```
Each agent → heartbeat every 5min → brain/NAMESPACE/heartbeat.json
08-watchtower → sweep every 15min → check PM2 + heartbeat staleness → auto-restart if stale
```
