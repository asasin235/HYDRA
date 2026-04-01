# HYDRA Project Memory

HYDRA is a multi-agent AI personal operating system running on Node.js 22+ (ES Modules) and PM2, with Slack as the primary interaction surface, Redis pub/sub for internal events, OpenRouter for multi-model LLM calls, SQLite for structured persistence, LanceDB for vector memory, and an Express dashboard for visualization.

## Architecture overview

```
Slack (Socket Mode) ─► 99-slack-gateway (Bolt router) ─► Agent.run()
                                                             │
                        ┌────────────────────────────────────┤
                        ▼                ▼                   ▼
                   core/agent.js    core/db.js         core/memory.js
                   (OpenRouter)     (SQLite WAL)       (LanceDB + RuVector)
                        │                │                   │
                        ▼                ▼                   ▼
                   core/bottleneck   core/bus.js        Embeddings via
                   ($50/mo budget)   (Redis pub/sub)    text-embedding-3-small
```

**25+ PM2 processes**: 13 agents + 11 data pipeline scripts + watchtower + gateway + health server.

## Repository structure

```
agents/           # 13 specialized agents + slack gateway (00-architect through 12-careerbot, 99-slack-gateway)
core/             # ~19 shared modules (agent, registry, db, memory, bus, bottleneck, logger, gws, etc.)
scripts/          # Data pipelines (ingest-audio, plaud-sync, gws-sync, sms-reader, dashboard, etc.)
prompts/          # System prompt .txt files per agent (never hardcode prompts in JS)
mcp/              # hydra-mcp-server.js — stdio MCP server (home control, trading, memory, status tools)
tests/            # Vitest test suite (smoke, core unit tests, integration tests)
dashboard/        # Express dashboard backend (TypeScript)
config/           # Configuration files
docker/           # Observability stack (Prometheus, Grafana, GlitchTip)
.planning/        # GSD project management (PROJECT.md, ROADMAP.md, STATE.md, phases/)
.shared/skills/   # Shared skill implementations
.github/          # Workflows, issue templates, Copilot instructions
```

## Important project facts

- `core/registry.js` is the **single source of truth** for all agent config (models, tiers, temps, namespaces, prompt files, context queries).
- `core/agent.js` is shared infrastructure — LLM calls via OpenRouter, tool loop, retry logic (3 attempts, exponential backoff), budget checks, context injection, conversation history.
- `core/db.js` owns SQLite schema (agent_state, debt_tracker, daily_logs, paper_trades, leads, transactions, conversations, sync_state) via better-sqlite3 in WAL mode.
- `core/memory.js` owns vector memory — LanceDB primary + optional RuVector dual-write (feature-gated via `RUVECTOR_*` env vars). Embedding model: `text-embedding-3-small` (1536 dims).
- `core/bus.js` owns Redis pub/sub channels (`hydra:agent.run`, `hydra:agent.error`, `hydra:health.alert`, `hydra:budget.warning`, `hydra:market.signal`). Non-fatal — agents continue if Redis is down.
- `core/bottleneck.js` enforces $50/month budget cap with 3-tier priority system and circuit breaker (3 failures in 5min = agent paused + Slack alert).
- `core/logger.js` provides Winston structured logging (JSON in prod, colored in dev). Never use `console.log`.
- `core/gws.js` wraps Google Workspace with two auth profiles: personal (aatif20@gmail.com) and work (aatif.rashid@goedmo.com).
- `ecosystem.config.cjs` owns PM2 process definitions. Agents: 512MB limit. Scripts: 256MB limit.
- `mcp/hydra-mcp-server.js` is the internal stdio MCP server (spawned on-demand by OpenClaw, not PM2-managed).
- `99-slack-gateway.js` is the central routing hub and tool dispatch point (~61K lines).

## Agents

| ID | Name | Role | Model | Tier |
|----|------|------|-------|------|
| 00 | architect | Chief of Staff, briefs, goal tracking | Gemini 2.5 Flash | 1 |
| 01 | edmobot | Work productivity, Jira/GitHub pipeline | Claude Haiku 4.5 | 1 |
| 02 | brandbot | Personal brand, LinkedIn drafts | Mistral Small 3.2 | 3 |
| 03 | sahibabot | Relationship health, promise tracking | Mistral Small 3.2 | 2 |
| 04 | socialbot | Social proxy, WhatsApp/iMessage/Discord | Claude Haiku 4.5 | 2 |
| 05 | jarvis | Home automation via Home Assistant | Gemini 2.5 Flash | 2 |
| 06 | cfobot | Personal CFO, spending analysis, debt | Gemini 2.5 Pro | 1 |
| 07 | biobot | Health tracker, Apple Health, HRV | Mistral Small 3.2 | 2 |
| 08 | watchtower | Health monitor & auto-healer (no LLM) | — | — |
| 09 | wolf | Paper trading, Nifty F&O analysis | Gemini 2.5 Pro | 3 |
| 10 | mercenary | Freelance pipeline, invoicing | Claude Sonnet 4.6 | 3 |
| 11 | auditor | Weekly reflection, agent scoring | Mistral Small 3.2 | 3 |
| 12 | careerbot | Career strategy, skill gaps | Claude Sonnet 4.6 | 3 |
| 99 | slack-gateway | Slack Bolt router & tool dispatch (no LLM) | — | — |

**Budget tiers**: Tier 1 runs at 100%, Tier 2 pauses at 80% utilization, Tier 3 pauses at 60%.

## Core modules reference

| Module | Responsibility |
|--------|---------------|
| `agent.js` | Base Agent class — LLM calls, tool loop, retries, budget, context, heartbeat |
| `registry.js` | Agent config registry (models, tiers, namespaces, prompts) |
| `bottleneck.js` | Budget enforcement, circuit breaker, tier-based pausing |
| `db.js` | SQLite wrapper, schema definitions, access helpers |
| `memory.js` | LanceDB + RuVector vector store, embeddings, semantic search |
| `bus.js` | Redis pub/sub event bus (non-fatal) |
| `logger.js` | Winston structured logging |
| `gws.js` | Google Workspace CLI wrapper (personal + work profiles) |
| `openclaw.js` | OpenClaw messaging gateway client |
| `filesystem.js` | Brain storage abstraction (`BRAIN_PATH/`) |
| `health-server.js` | Express health check server (port 3002) |
| `validate-env.js` | Per-agent environment variable validation |
| `review-queue-db.js` | Review queue persistence & lifecycle |
| `approval-pipeline.js` | Approval workflows for review items |
| `interaction-classifier.js` | Interaction classification (emails, messages, calls) |
| `people-db.js` | Contact/people storage |
| `enriched-memory.js` | Memory enrichment layer |
| `retention-engine.js` | Data retention management |
| `nr-instrument.js` | New Relic APM instrumentation |

## Data pipelines (scripts/)

| Script | Purpose |
|--------|---------|
| `ingest-audio.js` | Audio -> transcription -> summary -> review queue |
| `plaud-sync.js` | Plaud Note Pro recording sync (API polling or watch) |
| `gws-sync.js` | Google Workspace sync (Gmail, Calendar, Chat) |
| `sms-reader.js` | SMS banking message ingestion |
| `ingest-context.js` | Screen & audio context ingestion to memory |
| `audio-triage.js` | Audio file classification & review routing |
| `dashboard.js` | Express dashboard (port 3080) |
| `health-sync.js` | Health data sync |
| `screenpipe-sync.js` | Screenpipe activity integration |

## How to work in this repo

- **Read nearby code before editing.** Understand existing patterns first.
- **Prefer minimal, targeted diffs.** Don't refactor surrounding code.
- **Do not duplicate shared logic** that belongs in `core/`.
- **Do not hardcode agent metadata** outside `core/registry.js`.
- **Keep prompts in `prompts/*.txt`** — never inline in JS files.
- **Preserve structured logging** — use `createLogger('module-name')` from `core/logger.js`, never `console.log`.
- **Preserve retries, graceful shutdown, and budget-aware behavior** in agent code.
- **Use existing OpenRouter integration patterns** for all LLM work (via `core/agent.js`).
- **Treat dependency failures as non-fatal** unless the codebase already treats them as fatal. Return `null` or log warnings rather than throwing.
- **Always ES Modules** — use `import`/`export`, never `require()` (exception: `ecosystem.config.cjs`).
- **Tool definitions** use OpenAI function-calling format with an `execute` async handler.
- **Error handling in tools**: catch errors and return user-friendly messages. Never let unhandled rejections crash PM2 processes.
- **Token estimation heuristic**: ~4 characters per token (`Math.ceil(text.length / 4)`).

## Key conventions

```javascript
// Logging (always use Winston, never console.log)
import { createLogger } from '../core/logger.js';
const log = createLogger('module-name');
log.info('message', { context });

// Agent initialization
import Agent from '../core/agent.js';
import { AGENTS } from '../core/registry.js';
import { validateEnv } from '../core/validate-env.js';
validateEnv('01-edmobot');
const agent = new Agent({ name: '01-edmobot', ...AGENTS['01-edmobot'], tools: [] });

// Tool definition (OpenAI function-calling format)
{ name: 'tool_name', description: '...', parameters: { type: 'object', properties: {}, required: [] }, execute: async (args) => { ... } }

// Redis events (non-fatal)
import { publish, subscribe } from '../core/bus.js';
publish('health.alert', { agent, type, value });

// Error handling in tools
try { /* operation */ } catch (error) {
  log.error('description', { error: error.message, context });
  return { error: 'user-friendly message' };
}
```

## Testing

- **Framework**: Vitest (`vitest.config.js`)
- **Run tests**: `npm test` (watch mode) or `npm run test:ci` (CI with coverage)
- **Test location**: `tests/` — smoke tests, core unit tests, dashboard tests, integration tests
- **Always run `npm test` before marking work complete.** Fix failures before proceeding.

## Key scripts

```bash
npm start          # PM2 start all processes
npm run dev        # PM2 start MVP subset only
npm run setup      # Initialize project
npm test           # Run Vitest (watch mode)
npm run test:ci    # Run Vitest with coverage
npm run lint       # ESLint check
npm run lint:fix   # ESLint auto-fix
npm run coverage   # Coverage report
```

## Environment

- **Node.js**: >= 22.0.0 (ES Modules)
- **Required env vars**: `OPENROUTER_API_KEY`, `SLACK_BOT_TOKEN`, `BRAIN_PATH`
- **Storage path**: `~/hydra-brain/` (SQLite DB, LanceDB tables, brain files)
- **Ports**: 3002 (health server), 3080 (dashboard)
- **See**: `.env.example` and `sample.env` for full variable reference

## Architectural decisions

1. **Single source of truth**: All agent config in `core/registry.js` — models, tiers, namespaces, prompt files.
2. **Dual vector storage**: LanceDB (primary) + RuVector (optional, feature-gated via `RUVECTOR_*` env vars) for gradual migration.
3. **Non-fatal Redis bus**: Agents continue normally if Redis is down. Events are best-effort.
4. **3-tier budget system**: $50/month cap. Tier 1 always runs, Tier 2 pauses at 80%, Tier 3 at 60%.
5. **Circuit breaker**: 3 failures in 5 minutes = agent paused + Slack alert. Prevents cascading failures.
6. **Review queue workflow**: Audio ingested -> transcription -> summary -> review queue (STOP) -> human approval -> memory. No automated ingestion without human oversight.
7. **PM2 process isolation**: Each agent is a separate fork-mode process (512MB limit) with shared storage via SQLite/LanceDB/filesystem.
8. **Observability**: Winston logging + New Relic APM + Prometheus/Grafana + Sentry/GlitchTip (Docker stack in `docker/observability/`).

## Skill routing

- Use `hydra-agent-dev` for code changes to agents, prompts, tools, core modules, schemas, pipelines, PM2 config, or MCP tools.
- Use `linear-issues` for work planning, issue checks, issue creation, status changes, and completion workflows.
- Use `notion-docs` for architecture docs, runbooks, decision logs, prompt logs, module docs, and documentation updates tied to meaningful structural changes.

## Development workflow

- Test end-to-end before finishing.
- Mention touched files explicitly.
- Call out risk when editing shared infrastructure (`core/agent.js`, `core/db.js`, `core/memory.js`, `core/bottleneck.js`, `99-slack-gateway.js`).
- Keep commit intent concrete and implementation-friendly.
- Ensure docs and tracking stay aligned with major code changes.

## AI Workflow Rules

- Before starting any task, always fetch the current In Progress Linear issue from the Hydrajoker team via the Linear MCP.
- After completing any task, write a summary of changes to the linked Notion page via the Notion MCP, then mark the Linear issue as In Review.
- Always run `npm test` before marking work complete. Fix failures before proceeding.
- Commit messages must reference the Linear issue ID (for example `feat: add tool [HYD-123]`).
