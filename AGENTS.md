# HYDRA — Personal AI Operating System

> Agent instructions for working on the HYDRA codebase.

## Project Overview

HYDRA is a multi-agent personal AI operating system running on a Mac Mini M4. It orchestrates 13 specialized AI agents via PM2, communicates through Slack (Socket Mode), stores data in SQLite + LanceDB (vectors) + Redis (pub/sub), and serves a dashboard on Express (:3080).

**Runtime:** Node.js >= 22.0.0 (ES Modules, `"type": "module"` in package.json)
**Process Manager:** PM2 5.4.0 (ecosystem.config.cjs)
**Primary Interface:** Slack Bolt (Socket Mode) via `agents/99-slack-gateway.js`
**LLM Gateway:** OpenRouter API (models from Google, Anthropic, Mistral)
**Budget:** $50/month hard cap with 3-tier priority system

## Architecture

```
Slack (Socket Mode) → 99-slack-gateway.js → Agent.run() → OpenRouter LLM
                                                ↓
                                          Tool execution
                                                ↓
                                    SQLite + LanceDB + Redis Bus
```

### Key Patterns
- **Multi-agent:** 13 agents (00-architect through 12-careerbot), each a separate PM2 process
- **Event-driven:** Redis pub/sub bus (`core/bus.js`) for inter-agent communication
- **Shared storage:** All agents share one SQLite DB (`~/hydra-brain/brain/hydra.db`) and LanceDB vector store
- **Budget enforcement:** `core/bottleneck.js` enforces tiered spending limits with circuit breakers
- **Gateway pattern:** Single `99-slack-gateway.js` routes all Slack messages to agents, lazy-loads agent classes

## Directory Structure

```
agents/           → 13 agent implementations + slack-gateway
core/             → 19 shared modules (agent base, db, memory, bus, budget, logger, etc.)
scripts/          → Data pipelines (audio ingest, plaud-sync, gws-sync, dashboard, etc.)
prompts/          → System prompt .txt files for each agent
mcp/              → Model Context Protocol server
docker/           → Observability stack (Prometheus, Grafana, GlitchTip)
tests/            → Vitest test suite
docs/             → Documentation
```

## Critical Files

| File | Purpose |
|------|---------|
| `core/agent.js` | Base Agent class — run(), tool loop, context injection, conversation history |
| `core/registry.js` | Agent config source of truth — models, temperatures, tiers, namespaces |
| `core/db.js` | SQLite wrapper — all CRUD operations, schema definitions |
| `core/memory.js` | LanceDB + RuVector — semantic search, embeddings, dual-write |
| `core/bottleneck.js` | Budget enforcement, circuit breaker, tier-based pausing |
| `core/bus.js` | Redis pub/sub event bus for inter-agent communication |
| `core/gws.js` | Google Workspace API wrapper (Gmail, Calendar, Chat, Drive) |
| `agents/99-slack-gateway.js` | Slack Bolt gateway — message routing, tool dispatch, button actions |
| `scripts/dashboard.js` | Express dashboard (:3080) — agent management, spend tracking, memory browser |
| `ecosystem.config.cjs` | PM2 process definitions for all agents + scripts |

## Code Conventions

### Module System
- **Always use ES Modules** (`import`/`export`, never `require()`)
- File extensions: `.js` for all source, `.cjs` only for `ecosystem.config.cjs`
- Path aliases defined in `jsconfig.json`

### Logging
- Use `core/logger.js` factory: `const log = createLogger('module-name')`
- Levels: `error`, `warn`, `info`, `debug`
- JSON format in production, pretty-print in development
- Never use `console.log` — always use the Winston logger

### Error Handling
- All agent tool functions must catch errors and return user-friendly error messages
- Never let unhandled rejections crash PM2 processes
- Use circuit breaker pattern: 3 failures in 5 min → agent paused → Slack alert
- Always log errors with full context: `log.error('description', { error: err.message, agentName, ... })`

### Database
- SQLite via `better-sqlite3` — synchronous API, WAL mode
- All schema changes go in `core/db.js` `initDB()` function with `CREATE TABLE IF NOT EXISTS`
- Use parameterized queries — never interpolate user input into SQL
- LanceDB for vector search — all writes go through `core/memory.js`

### Agent Development
- Every agent extends the base pattern in `core/agent.js`
- System prompts live in `prompts/{agent-name}.txt` — never hardcode prompts in JS
- Tools are defined as OpenAI function-calling format objects
- Tool implementations go in `agents/99-slack-gateway.js` `AGENT_TOOLS` map
- Register new agents in `core/registry.js` with: name, model, temperature, tier, namespace, contextQuery

### Environment Variables
- All env vars documented in `sample.env` (223 lines)
- Per-agent validation via `core/validate-env.js` — call `validateEnv([...])` on startup
- Sensitive values: never commit `.env`, use `sample.env` as template

## Testing

- Framework: **Vitest** (`npm test`)
- Test files: `tests/` directory, matching `*.test.js` pattern
- Mock external APIs (OpenRouter, Slack, Jira, GitHub) — never make real API calls in tests
- Priority test targets: `core/bottleneck.js`, `core/agent.js`, `core/db.js`, `core/bus.js`

## Build & Run Commands

```bash
npm start          # Launch all agents + scripts via PM2
npm run dev        # Launch MVP subset (Architect + CFO + Jarvis + Gateway)
npm test           # Run vitest test suite
npm run lint       # ESLint check
pm2 logs           # View all agent logs
pm2 restart <name> # Restart specific agent
```

## Integration Points

| Service | Module | Auth |
|---------|--------|------|
| Slack | `@slack/bolt` (Socket Mode) | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` |
| OpenRouter | `openai` SDK | `OPENROUTER_API_KEY` |
| Jira | `core/jira.js` | `JIRA_API_TOKEN` |
| GitHub | `core/github.js` | `GITHUB_TOKEN` |
| Google Workspace | `core/gws.js` | Service account JSON |
| Home Assistant | `agents/05-jarvis.js` | `HOME_ASSISTANT_URL` + token |
| Plaud Note | `scripts/plaud-sync.js` | `PLAUD_TOKEN` |
| Redis | `ioredis` | `REDIS_URL` (default: localhost:6379) |

## Linear Integration

Issues are tracked in Linear under the **Hydrajoker** team. Projects:
- 🐉 HYDRA Core Infrastructure
- 🎤 Audio Intelligence Pipeline
- 🖥️ Screen Activity Pipeline
- 🧠 Vector Memory System
- 💬 Slack Dashboard
- 🤖 Agent Implementation

When creating issues, follow the existing format: clear title, structured description with Requirements/Files/Dependencies sections, appropriate labels (infra, pipeline, ai, research), and priority levels matching impact.

## Notion Documentation

Documentation lives in the HYDRA Notion workspace. When implementing features:
1. Update the relevant Notion page with architecture decisions
2. Document API changes, new env vars, and schema changes
3. Keep the "Research Lab" section updated with experimental findings

## Common Pitfalls

1. **Never use `require()`** — this is an ES Module project
2. **Never hardcode API keys** — always use env vars
3. **Never skip budget checks** — all LLM calls must go through `core/bottleneck.js`
4. **Never write to LanceDB directly** — always use `core/memory.js` functions
5. **Never modify prompts in JS** — edit `prompts/*.txt` files instead
6. **Always handle SIGTERM** — PM2 sends SIGTERM on restart, clean up intervals/connections
7. **Watch for prompt drift** — the auditor can cause duplicate text in prompt files; always deduplicate
8. **RuVector dual-write** — when writing to LanceDB, `dualWrite()` is automatic; don't write to RuVector separately
