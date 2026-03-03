# 🧠 Core Modules

All shared infrastructure lives in `core/`. **Never duplicate logic that belongs here** — if two agents need the same capability, it goes in `core/`.

## `core/agent.js` — Base Agent Class

The foundation every LLM-powered agent builds on.

- **LLM calls** via OpenRouter (OpenAI-compatible API)
- **Tool-calling loop** — up to 10 iterations per run
- **Retry with exponential backoff** — 3 attempts (1s → 2s → 4s) on 429/502/503/timeout
- **Budget enforcement** — estimates token usage, blocks if over tier limit
- **Context injection** — auto-searches LanceDB using the agent's `contextQuery` from registry
- **Heartbeat** — writes `heartbeat.json` every 5 minutes to brain storage
- **Conversation history** — in-memory + SQLite, injected into every prompt, auto-pruned
- **Graceful shutdown** — SIGTERM/SIGINT handlers clear intervals and close health server
- **Winston logging** — structured logs via `core/logger.js`

```js
import { Agent } from '../core/agent.js';

const agent = new Agent({
  name: '05-jarvis',          // must match registry key
  tools: [...],               // array of { name, description, parameters, execute }
  namespace: '05_JARVIS',     // brain storage namespace
  // model, systemPromptPath, temperature etc. auto-loaded from core/registry.js
});

await agent.run('Turn on the AC');
```

## `core/registry.js` — Agent Configuration

**Single source of truth** for all agent config.

```js
import { AGENTS, AGENT_NAMES, TIER1 } from '../core/registry.js';

AGENTS['05-jarvis']  // → { name, model, namespace, tier, promptFile, contextQuery, ... }
AGENT_NAMES          // → ['00-architect', '01-edmobot', ...]
TIER1                // → ['00-architect', '01-edmobot', '06-cfobot']
```

> Always import from here. Never hardcode model IDs, namespaces, or tier assignments in agent files.

## `core/bottleneck.js` — Budget & Circuit Breaker

- **$50/month** hard budget cap
- **Tier-based pausing**: Tier 2 pauses at 80%, Tier 3 at 60%
- **Circuit breaker**: 3 failures in 5 minutes → agent disabled, Slack alert sent
- **Usage tracking**: per-agent daily/monthly token + cost in `brain/usage/` JSON files

```js
import { checkBudget, trackUsage } from '../core/bottleneck.js';

const allowed = await checkBudget('05-jarvis');
if (!allowed) return 'Budget exceeded';
// ... LLM call ...
await trackUsage('05-jarvis', inputTokens, outputTokens, model);
```

## `core/db.js` — SQLite Database

Wrapper around `better-sqlite3` in WAL mode.

**Tables:**
| Table | Purpose |
|-------|---------|
| `agent_state` | Per-agent persistent key-value state |
| `debt_tracker` | CFO bot debt items |
| `daily_logs` | Agent daily summaries |
| `paper_trades` | Wolf bot paper trades |
| `leads` | Mercenary bot lead pipeline |
| `transactions` | Bank SMS transactions (from sms-reader.js) |
| `conversation_history` | Agent conversation history |

```js
import db from '../core/db.js';

const rows = db.prepare('SELECT * FROM transactions WHERE category = ?').all('Food');
```

## `core/memory.js` — LanceDB Vector Store

Semantic memory backed by LanceDB with OpenRouter embeddings.

**Tables:** `memories`, `daily_logs`, `reflections`, `screen_activity`, `audio_transcripts`, `context_feed`

**Embedding model:** `text-embedding-3-small` (1536 dimensions) via OpenRouter

```js
import { searchAllContext, addScreenActivity } from '../core/memory.js';

// Search across all context sources
const results = await searchAllContext('home automation temperature');

// Add new screen activity
await addScreenActivity({ timestamp, source: 'screenpipe', summary, apps });
```

## `core/bus.js` — Redis Event Bus

Redis pub/sub for inter-agent communication via `ioredis`.

**Channels:**
- `hydra:agent.run` — agent started a task
- `hydra:agent.error` — agent encountered an error
- `hydra:health.alert` — health/budget alert
- `hydra:budget.warning` — budget threshold reached
- `hydra:market.signal` — market signal from Wolf

```js
import { publish, subscribe } from '../core/bus.js';

// Fire-and-forget (always .catch(() => {}))
publish('hydra:agent.run', { agent: '05-jarvis', task: 'Turn on AC' }).catch(() => {});

// Subscribe
subscribe('hydra:health.alert', (message) => { /* handle */ });
```

> **Bus events are fire-and-forget** — always `.catch(() => {})` on `publish()` calls. Redis down = non-fatal.

## `core/filesystem.js` — Brain File I/O

Atomic file operations for agent brain storage.

```js
import { readBrain, writeBrain, appendBrain } from '../core/filesystem.js';

// Read agent state
const state = await readBrain('06_CFO', 'sms_inbox.json');

// Write atomically (write to .tmp then rename)
await writeBrain('06_CFO', 'heartbeat.json', { ts: Date.now() });

// Append to JSON array
await appendBrain('06_CFO', 'daily_log.json', { date, summary });
```

All paths are rooted at `$BRAIN_PATH/brain/<NAMESPACE>/` with path traversal protection.

## `core/logger.js` — Winston Logging

```js
import { createLogger } from '../core/logger.js';

const log = createLogger('05-jarvis');
log.info('Turning on AC', { temperature: 24 });
log.warn('Home Assistant unreachable');
log.error('Failed to get sensor data', { error: err.message });
```

- JSON output in PM2/production
- Colour-coded pretty-print in dev (detected via `PM2_HOME` env var)

## `core/validate-env.js` — Startup Validation

Per-agent env var checks at startup. Fails fast with clear messages.

```js
import { validateEnv } from '../core/validate-env.js';

// At top of every agent file — checks only the vars that agent needs
validateEnv('05-jarvis');
```

## `core/openclaw.js` — Messaging Gateway

Sends messages via the OpenClaw CLI binary.

```js
import { sendWhatsApp, sendIMessage, isGatewayAvailable } from '../core/openclaw.js';

if (await isGatewayAvailable()) {
  await sendWhatsApp('+91XXXXXXXXXX', 'Hello from HYDRA');
}
```

Exports: `sendMessage`, `sendWhatsApp`, `sendIMessage`, `sendDiscord`, `sendTelegram`, `getGatewayStatus`, `isGatewayAvailable`

## `core/github.js` — GitHub API (Dual Account)

Supports personal and work GitHub accounts.

```js
import { createBranch, createPR, getFileContent } from '../core/github.js';

// Default: work account (used by edmobot)
const content = await getFileContent('org/repo', 'src/file.js');
await createBranch('org/repo', 'fix/EDMO-123', 'main');
await createPR('org/repo', { title, body, head, base });

// Personal account
const content = await getFileContent('asasin235/repo', 'README.md', 'personal');
```

## `core/jira.js` — Jira Cloud API

```js
import { getMyTickets, transitionTicket, addJiraComment } from '../core/jira.js';

const tickets = await getMyTickets(['In Progress', 'To Do']);
await transitionTicket('EDMO-123', 'In Progress');
await addJiraComment('EDMO-123', 'Fixed in PR #456');
```
