# 🐉 HYDRA — Future Improvements

> This document tracks all planned and suggested improvements for the HYDRA Personal AI Operating System, categorized by priority.

---

## 🔴 Critical / High Priority

### 1. Multi-Round Tool Call Loop

**Problem:** `core/agent.js` only handles **one round** of tool calls. If the follow-up LLM response also contains tool calls (multi-step reasoning), they are silently ignored. This directly breaks `edmobot` (Jira → GitHub pipeline) and `wolf` (multi-step market analysis).

**Fix:**
```js
// core/agent.js
const MAX_TOOL_ITERATIONS = 10;
let iterations = 0;

while (
  assistantMessage.tool_calls?.length &&
  this.tools?.length &&
  iterations < MAX_TOOL_ITERATIONS
) {
  // process tools, push results to transcript
  // re-call model with updated transcript
  iterations++;
}
```

**Files to change:** `core/agent.js`

---

### 2. Context Window Blindness

**Problem:** `estimateTokensFromMessages()` uses a naive `chars / 4` heuristic with no guard against exceeding the model's context window. LanceDB context snippets can silently overflow cheaper models (e.g. Mistral Small has a 32K context).

**Fix:** Add per-model `MAX_CONTEXT_TOKENS` in `core/registry.js` and truncate `contextSnippets` before building the messages array.

```js
// core/registry.js — add to each agent entry
maxContextTokens: 32000, // model-specific limit
```

**Files to change:** `core/registry.js`, `core/agent.js`

---

### 3. No Persistent Conversation History

**Problem:** Every `agent.run()` starts fresh — there is no multi-turn memory within a session. If you ask `@hydra cfobot how much did I spend today?` and follow up with `break it down by category`, CFOBot has no idea what "it" refers to.

**Fix:** Add a lightweight in-memory conversation buffer per agent (last N turns), and optionally persist it to SQLite for cross-session continuity.

```js
// core/agent.js
this._conversationHistory = []; // max last 10 turns
```

**Files to change:** `core/agent.js`, `core/db.js`

---

## 🟡 Architecture Improvements

### 4. Hardcoded `temperature: 0.4` for All Agents

**Problem:** Every agent uses `temperature: 0.4` regardless of task type. Creative agents like `brandbot` or `sahibabot` (drafting messages) benefit from higher temperatures (~0.7–0.8), while deterministic agents like `cfobot` (financial math) or `edmobot` (code changes) should use 0.1–0.2.

**Fix:** Add a `temperature` field to each agent config in `core/registry.js`.

```js
// core/registry.js
'01-edmobot': { ..., temperature: 0.1 },
'02-brandbot': { ..., temperature: 0.75 },
'06-cfobot':  { ..., temperature: 0.1 },
'03-sahibabot': { ..., temperature: 0.7 },
```

**Files to change:** `core/registry.js`, `core/agent.js`

---

### 5. Single Health Port = Race Condition in PM2

**Problem:** All agents share port `3002` via a module-level `_healthServer` singleton in `core/agent.js`. Since PM2 spawns each agent as a **separate process**, the singleton doesn't work across processes. Only the first process to start actually serves the health endpoint.

**Fix:** Move the health server to a **dedicated `health-server.js` PM2 service** that all agents report into via a shared SQLite table.

**Files to change:** `core/agent.js`, new `core/health-server.js`, `ecosystem.config.cjs`

---

### 6. Dual Memory System Duplication

**Problem:** Two parallel memory systems exist — LanceDB (`core/memory.js`) and OpenClaw-backed markdown files (`core/openclaw-memory.js`). This creates redundant writes, inconsistent search results, and double storage cost. The README even labels LanceDB as "legacy."

**Fix:** Deprecate `openclaw-memory.js`. Make LanceDB the canonical brain. `ingest-context.js` should be the only writer.

**Files to change:** `core/openclaw-memory.js` (deprecate), `core/memory.js`

---

### 7. No Agent-to-Agent Communication

**Problem:** Agents are isolated islands that only communicate via Slack roundtrips. There's no way for `07-biobot` to tell `00-architect` "user is low HRV, reduce cognitive load today" in real-time.

**Fix:** Implement a lightweight internal pub/sub using SQLite `agent_state` table or Node.js `EventEmitter` with IPC.

```js
// new core/bus.js
export function publish(channel, payload) { /* write to agent_state */ }
export function subscribe(channel, callback) { /* poll or IPC listen */ }
```

**Files to change:** `core/db.js`, `core/agent.js`, new `core/bus.js`

---

## 🟢 Code Quality & DX

### 8. Tests Are Placeholder Stubs

**Problem:** The `tests/` directory exists but all Sprint 2 tests are unimplemented. For a system that autonomously makes PRs, sends WhatsApp messages, and controls home appliances, this is a real risk.

**Priority test targets:**
- `core/bottleneck.js` — budget enforcement logic
- `core/agent.js` — tool call loop, retry logic
- `core/github.js` — PR creation (mock the API)
- `core/db.js` — SQLite CRUD operations

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

## 💡 Feature Backlog

### 11. Wolf — No Live Market Data

**Problem:** Wolf's Nifty F&O analysis uses Perplexity Sonar for market "data" — meaning all analysis is based on AI-summarized news, not actual live tick data. Paper trades are based on LLM inference about prices, not actual quotes.

**Fix:** Integrate [NSE India API](https://github.com/nsepy/nsepy) or Zerodha Kite Connect (free tier) for real option chain data before analysis.

**Files to change:** `agents/09-wolf.js`, new `core/nse.js`

---

### 12. CFOBot Has No Real Spending Data Source

**Problem:** SMS Automation is a backlog item. Until then, `06-cfobot` has no real spending data source.

**Interim Fix:** Build an iOS Shortcut that forwards bank SMS messages to a webhook endpoint on your Mac Mini, which writes them to the `debt_tracker` SQLite table. This is a weekend project.

---

### 13. No Dashboard / Web UI

**Problem:** HYDRA can only be interrogated via Slack or the raw `/health` endpoint. No visual overview of agent status, daily spend, logs, or heartbeats.

**Fix:** Minimal read-only dashboard using **Hono.js + htmx** as a single `dashboard.js` PM2 process — no build step required.

**Suggested views:**
- Agent status grid (healthy / paused / circuit-open)
- Real-time token spend vs budget
- Recent agent logs feed
- Heartbeat timeline per agent

---

### 14. SahibaBot Data Privacy Risk

**Problem:** Relationship data (promises, WhatsApp drafts, date suggestions) is stored in plaintext SQLite and backed up unencrypted to Google Drive.

**Fix:** Encrypt sahibabot-namespaced rows using `better-sqlite3-sqlcipher`, or add a `SENSITIVE=true` flag to the namespace config that excludes those files from cloud backups.

**Files to change:** `core/db.js`, `core/filesystem.js`, `agents/03-sahibabot.js`

---

### 15. CareerBot — Phase 2

**Status:** Reserved slot `08-careerbot`.

**Suggested model:** Claude Sonnet 4.6 (requires deep reasoning)

**Suggested tools:**
- LinkedIn profile analysis
- GitHub contribution graph analysis
- Resume diff tracker (compare current skills vs target JD)
- Skill gap scoring with learning resource suggestions
- Salary benchmarking via public data sources

---

## 📊 Improvement Priority Matrix

| # | Improvement | Impact | Effort | Priority |
|---|-------------|--------|--------|----------|
| 1 | Multi-round tool loop | High | Low | 🔴 Critical |
| 2 | Context window guards | High | Low | 🔴 Critical |
| 3 | Conversation history | High | Medium | 🔴 Critical |
| 4 | Per-agent temperature | Medium | Low | 🟡 High |
| 5 | Health port fix | Medium | Medium | 🟡 High |
| 6 | Memory deduplication | Medium | Medium | 🟡 High |
| 7 | Agent-to-agent IPC | High | High | 🟡 High |
| 8 | Unit tests | High | High | 🟢 Medium |
| 9 | Prompt versioning | Low | Low | 🟢 Low |
| 10 | TypeScript migration | Medium | High | 🟢 Low |
| 11 | Wolf live market data | High | Medium | 💡 Backlog |
| 12 | CFOBot SMS ingestion | High | Low | 💡 Backlog |
| 13 | Web dashboard | Medium | Medium | 💡 Backlog |
| 14 | SahibaBot encryption | Medium | Low | 💡 Backlog |
| 15 | CareerBot Phase 2 | Medium | High | 💡 Backlog |

---

*Last updated: 2026-02-28*
