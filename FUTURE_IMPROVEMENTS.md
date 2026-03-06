# 🐉 HYDRA — Future Improvements

> This document tracks all planned and suggested improvements for the HYDRA Personal AI Operating System, categorized by priority.

---

## ✅ Completed

| # | Improvement | Completed |
|---|-------------|-----------|
| 1 | Multi-round tool call loop (max 10 iterations) | `core/agent.js` |
| 3 | Persistent conversation history (SQLite `conversation_history`) | `core/agent.js`, `core/db.js` |
| 4 | Per-agent temperature config in registry | `core/registry.js` |
| 5 | Dedicated health server (port collision fix) | `core/health-server.js` |
| 7 | Agent-to-agent pub/sub via Redis | `core/bus.js` |
| 13 | Web dashboard with agent status, spend, logs | `scripts/dashboard.js` |
| 15 | CareerBot Phase 2 (12-careerbot.js) | `agents/12-careerbot.js` |
| — | RuVector integration (dual-write, shadow-read, primary-read modes) | `core/ruvectorStore.js` |

---

## 🔴 Critical / High Priority

### 2. Context Window Blindness

**Problem:** `estimateTokensFromMessages()` uses a naive `chars / 4` heuristic with no guard against exceeding the model's context window. RuVector/LanceDB context snippets can silently overflow cheaper models (e.g. Mistral Small has a 32K context).

**Fix:** Add per-model `maxContextTokens` in `core/registry.js` and truncate `contextSnippets` before building the messages array.

```js
// core/registry.js — add to each agent entry
maxContextTokens: 32000, // model-specific limit
```

**Files to change:** `core/registry.js`, `core/agent.js`

---

### 16. RuVector Full Migration — Decommission LanceDB

**Problem:** HYDRA now runs a dual-write strategy (LanceDB + RuVector), but LanceDB remains the primary read path. The backfill script (`scripts/backfill-lancedb-to-ruvector.js`) exists but migration has not been completed. Every vector write incurs double cost and latency.

**Fix:**
1. Run the backfill script once to migrate all historical LanceDB data to RuVector.
2. Flip `RUVECTOR_MODE=primary` in `.env` to make RuVector the sole read path.
3. Archive LanceDB files and remove `core/memory.js` dual-write paths.
4. Update `core/memory.js` to delegate all reads/writes to `core/ruvectorStore.js`.

**Files to change:** `core/memory.js`, `core/ruvectorStore.js`, `.env`

---

### 17. No Structured Agent Performance Metrics

**Problem:** There is no way to know which agents are actually useful. Token spend is tracked but there is no signal on whether an agent's output led to a positive outcome (code merged, trade profitable, reminder acted on).

**Fix:** Add an `outcomes` SQLite table. Every agent run gets an outcome row. Slack reactions (✅ 👍 ❌) on agent responses are used as implicit feedback signals, written back to the DB by the gateway.

```js
// core/db.js — new table
CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  agent TEXT,
  run_id TEXT,
  slack_ts TEXT,
  reaction TEXT,     -- 'thumbsup' | 'thumbsdown' | 'white_check_mark'
  recorded_at TEXT
);
```

**Files to change:** `core/db.js`, `agents/99-slack-gateway.js`, `scripts/dashboard.js`

---

## 🟡 Architecture Improvements

### 6. Dual Memory System Duplication

**Problem:** Two parallel memory systems exist — `core/memory.js` (LanceDB) and `core/openclaw-memory.js` (Markdown files). With RuVector now integrated, there are effectively **three** overlapping systems. This creates redundant writes, inconsistent search results, and storage drift.

**Fix:** Deprecate `core/openclaw-memory.js`. Make RuVector (via `core/ruvectorStore.js`) the single canonical vector brain. `ingest-context.js` should be the only writer; `core/memory.js` becomes a thin wrapper over RuVector.

**Files to change:** `core/openclaw-memory.js` (deprecate), `core/memory.js`, `core/ruvectorStore.js`

---

### 18. Architect Agent Has No Actual Orchestration Power

**Problem:** `00-architect` runs on a cron schedule and posts strategic briefs to Slack, but it cannot actually trigger other agents or create tasks. It's a read-only observer, not an orchestrator.

**Fix:** Give Architect a `trigger_agent` tool that publishes to `core/bus.js` on the `hydra:agent.run` channel. This lets it spin up `09-wolf` for a market scan, or push a task to `01-edmobot`, based on strategic assessment.

```js
// tool in agents/00-architect.js
{
  name: 'trigger_agent',
  description: 'Trigger another HYDRA agent to run a task',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Agent name, e.g. 09-wolf' },
      task: { type: 'string', description: 'Natural language task description' }
    },
    required: ['agent', 'task']
  },
  execute: async ({ agent, task }) => {
    await publish('hydra:agent.run', { agent, task, triggeredBy: '00-architect' });
    return `Triggered ${agent} with task: ${task}`;
  }
}
```

**Files to change:** `agents/00-architect.js`, `core/bus.js`

---

### 19. No Graceful Shutdown / Drain on PM2 Reload

**Problem:** PM2 `reload` sends `SIGINT` to agents mid-LLM-call. In-progress tool calls are lost silently. There is no drain logic to finish the current run before shutting down.

**Fix:** Add a `process.on('SIGINT')` handler in `core/agent.js` that sets a `_shuttingDown` flag, waits for any active run to complete (max 30s), then exits cleanly.

```js
// core/agent.js
process.on('SIGINT', async () => {
  this._shuttingDown = true;
  await this._activeRunPromise; // wait up to 30s
  process.exit(0);
});
```

**Files to change:** `core/agent.js`

---

### 20. Bus Events Have No Dead-Letter Queue

**Problem:** Redis pub/sub events on `hydra:agent.run` / `hydra:market.signal` etc. are fire-and-forget. If the subscriber process is down when an event fires, the message is permanently lost with no retry.

**Fix:** Add a lightweight dead-letter queue using a Redis `LPUSH` list per channel. Failed consumers push to `hydra:dlq:<channel>`. A recovery cron in `08-watchtower.js` drains and retries them on startup.

**Files to change:** `core/bus.js`, `agents/08-watchtower.js`

---

## 🟢 Code Quality & DX

### 8. Tests Are Placeholder Stubs

**Problem:** The `tests/` directory exists but most tests are unimplemented. For a system that autonomously makes PRs, sends WhatsApp messages, and controls home appliances, this is a real risk.

**Priority test targets:**
- `core/bottleneck.js` — budget enforcement logic
- `core/agent.js` — tool call loop, retry logic, conversation history
- `core/ruvectorStore.js` — vector store CRUD, shadow-read comparison
- `core/db.js` — SQLite CRUD operations
- `agents/99-slack-gateway.js` — routing logic (unit test with mock Slack events)

---

### 9. Prompt Versioning Is Implicit

**Problem:** The auditor auto-commits prompt changes via git, but there's no structured changelog for prompt versions. You can't easily diff what changed in `prompts/06-cfobot.txt` between last Sunday and this Sunday without reading git history.

**Fix:** Add a `prompts/versions/` directory where the auditor writes a dated snapshot before each modification.

```
prompts/
  versions/
    06-cfobot.2026-02-23.txt
    06-cfobot.2026-03-02.txt  ← new snapshot before each edit
  06-cfobot.txt               ← current active prompt
```

**Files to change:** `agents/11-auditor.js`

---

### 10. No TypeScript on Agent Files

**Problem:** `jsconfig.json` enables `checkJs` but agent files have complex async patterns. Runtime errors in production (e.g. `undefined is not a function` in a tool execute callback) are hard to catch.

**Fix:** Migrate `core/` modules to TypeScript with `.d.ts` types. Start with typed interfaces for `Agent`, `Tool`, and registry exports.

---

### 21. Dashboard Has No Auth

**Problem:** `scripts/dashboard.js` is exposed on the local network without authentication. Anyone on the same Wi-Fi can view agent status, token spend, and restart agents via `POST /api/restart/:name`.

**Fix:** Add a simple `DASHBOARD_PASSWORD` env var with HTTP Basic Auth middleware on all routes. One-liner with the `express-basic-auth` package.

```js
import basicAuth from 'express-basic-auth';
app.use(basicAuth({ users: { admin: process.env.DASHBOARD_PASSWORD }, challenge: true }));
```

**Files to change:** `scripts/dashboard.js`

---

## 💡 Feature Backlog

### 11. Wolf — No Live Market Data

**Problem:** Wolf's Nifty F&O analysis uses Perplexity Sonar for market "data" — meaning all analysis is based on AI-summarized news, not actual live tick data. Paper trades are based on LLM inference about prices, not actual quotes.

**Fix:** Integrate [NSE India API](https://github.com/nsepy/nsepy) or Zerodha Kite Connect (free tier) for real option chain data before analysis.

**Files to change:** `agents/09-wolf.js`, new `core/nse.js`

---

### 12. CFOBot — UPI / Payment App Integration

**Problem:** `sms-reader.js` captures Indian bank SMS but misses UPI transactions from PhonePe/GPay which often arrive as push notifications instead of SMS. Significant spending is invisible to CFOBot.

**Fix:** Build an Android Tasker profile (or iOS Shortcuts action) that captures UPI notification text and forwards it to the same Mac Mini SMS webhook used by `sms-reader.js`. Alternatively, integrate the HDFC/ICICI bank statement CSV export via a weekly email parser.

**Files to change:** `scripts/sms-reader.js`, `agents/06-cfobot.js`

---

### 14. SahibaBot Data Privacy Risk

**Problem:** Relationship data (promises, WhatsApp drafts, date suggestions) is stored in plaintext SQLite and backed up unencrypted to Google Drive.

**Fix:** Encrypt sahibabot-namespaced rows using `better-sqlite3-sqlcipher`, or add a `SENSITIVE=true` flag to the namespace config that excludes those files from cloud backups.

**Files to change:** `core/db.js`, `core/filesystem.js`, `agents/03-sahibabot.js`

---

### 22. HYDRA Local CLI (`hydra` command)

**Problem:** The only way to interact with HYDRA is via Slack. When Slack is unavailable, offline, or inconvenient (e.g. terminal workflow), there's no way to query agents or check system status locally.

**Fix:** Build a small Node.js CLI (`scripts/hydra-cli.js`) installed globally via `npm link`. Subcommands:

```sh
hydra ask jarvis "what's on my calendar today?"
hydra status              # agent health table
hydra logs 06-cfobot      # tail PM2 logs for an agent
hydra budget              # show spend vs cap
hydra restart 01-edmobot  # PM2 restart wrapper
```

**Files to change:** new `scripts/hydra-cli.js`, `package.json` (add `bin` entry)

---

### 23. Wolf — Paper Trade P&L Analytics

**Problem:** `09-wolf` records paper trades to SQLite but there's no aggregated view of win rate, average return, max drawdown, or trade duration. It's impossible to evaluate Wolf's strategy quality over time.

**Fix:** Add a `wolf_analytics` view to `core/db.js` and a `/wolf` route on the dashboard showing: total trades, win%, avg P&L per trade, best/worst trade, rolling 7-day equity curve (Chart.js).

**Files to change:** `core/db.js`, `scripts/dashboard.js`

---

### 24. Screenpipe — Deep Work Session Detection

**Problem:** Screenpipe ingests raw OCR text into LanceDB but there's no higher-level analysis of work patterns. HYDRA has all the data to answer "how many hours of deep work did I do this week?" but nothing queries it.

**Fix:** Add a weekly cron to `07-biobot` (or a new `screenpipe-analytics.js` script) that scans the `screen_activity` LanceDB table, clusters app/context switches, and produces a weekly "focus report" posted to `#07-biobot`.

**Metrics to surface:**
- Deep work hours (>25 min uninterrupted in IDE/docs)
- Context switch frequency per day
- Top 5 apps by active screen time
- Distraction index (social/news apps during work hours)

**Files to change:** `agents/07-biobot.js` or new `scripts/screenpipe-analytics.js`

---

### 25. Auditor — A/B Prompt Testing

**Problem:** `11-auditor` rewrites prompts based on its own judgment, but there's no mechanism to compare two prompt variants objectively. A bad prompt rewrite could silently degrade agent quality for weeks.

**Fix:** When auditor proposes a change, it stores both the `current` and `proposed` prompt variants in a new `prompt_experiments` SQLite table. For the next 7 days, 50% of agent runs use the new prompt (selected by run timestamp parity). Outcome reactions (via the #17 outcomes system) determine which wins.

**Files to change:** `agents/11-auditor.js`, `core/db.js`, `core/agent.js`

---

### 26. BioBot — Wearable Data Integration

**Problem:** `07-biobot` currently relies on manual HRV input or Plaud audio mentions of health. There's no automated data stream from wearables.

**Fix:** Integrate Apple Health export (via iOS Shortcut → webhook) or Garmin Connect API to pull daily HRV, sleep score, resting HR, and step count. Feed these as structured facts into each morning biobot run instead of relying on self-reported audio.

**Supported sources:**
- Apple Health via iOS Shortcut (daily export to webhook)
- Garmin Connect API (OAuth2, free tier)
- Whoop API (if applicable)

**Files to change:** `agents/07-biobot.js`, new `core/health-data.js`

---

## 📊 Improvement Priority Matrix

| # | Improvement | Impact | Effort | Priority |
|---|-------------|--------|--------|----------|
| 2 | Context window guards | High | Low | 🔴 Critical |
| 16 | RuVector full migration (decommission LanceDB) | High | Medium | 🔴 Critical |
| 17 | Agent performance metrics + Slack reaction feedback | High | Medium | 🔴 Critical |
| 6 | Memory system consolidation (3 → 1) | Medium | Medium | 🟡 High |
| 18 | Architect orchestration via bus triggers | High | Low | 🟡 High |
| 19 | Graceful shutdown / drain on PM2 reload | Medium | Low | 🟡 High |
| 20 | Bus dead-letter queue | Medium | Low | 🟡 High |
| 8 | Unit tests (bottleneck, agent loop, ruvector) | High | High | 🟢 Medium |
| 9 | Prompt versioning | Low | Low | 🟢 Low |
| 10 | TypeScript migration | Medium | High | 🟢 Low |
| 21 | Dashboard auth | Medium | Low | 🟢 Low |
| 11 | Wolf live market data (NSE/Kite) | High | Medium | 💡 Backlog |
| 12 | CFOBot UPI/notification ingestion | High | Low | 💡 Backlog |
| 14 | SahibaBot encryption | Medium | Low | 💡 Backlog |
| 22 | HYDRA local CLI | Medium | Low | 💡 Backlog |
| 23 | Wolf paper trade P&L analytics | Medium | Low | 💡 Backlog |
| 24 | Screenpipe deep work session detection | Medium | Medium | 💡 Backlog |
| 25 | Auditor A/B prompt testing | Low | Medium | 💡 Backlog |
| 26 | BioBot wearable data integration | High | Medium | 💡 Backlog |

---

*Last updated: 2026-03-06*
