# HYDRA — Comprehensive Improvement Roadmap

> A prioritized roadmap for evolving HYDRA from a reactive multi-agent system into a proactive personal AI operating system.

---

## Context

HYDRA is a 13-agent personal AI operating system running on a Mac Mini, orchestrated via PM2, communicating through Slack, with SQLite + LanceDB storage, Redis pub/sub event bus, and a full Express dashboard. It already handles work management (Jira/GitHub), finances (SMS banking), health tracking (Apple Health), home automation, relationship management, personal branding, trading research, freelancing, and career development.

**What's been completed (Sprints 1-3):** Multi-round tool loops, context window guards, conversation history, per-agent temperature, health server, Redis bus, SMS reader, dashboard with WebSocket/charts/prompt editor/memory browser, CareerBot, audio triage pipeline, Plaud sync, New Relic/Prometheus observability.

**What's still broken or missing:** The prompt files have severe repetition/drift from the auditor's reflection system, `openclaw-memory.js` is still used in parallel with LanceDB, tests are near-zero, agents are almost entirely reactive (only Architect has cron briefs), no cross-agent workflows exist, and there's no structured goal/habit/decision tracking.

This roadmap proposes **35 improvements across 4 priority tiers**, organized for execution in 2-week sprints.

---

## Status of Previously Identified Items (FUTURE_IMPROVEMENTS.md)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Multi-round tool call loop | **DONE** | `MAX_TOOL_ITERATIONS = 15` in `core/agent.js` |
| 2 | Context window guards | **DONE** | `maxContextTokens` per agent with truncation |
| 3 | Persistent conversation history | **DONE** | `conversation_history` table + injection in `agent.js` |
| 4 | Per-agent temperature | **DONE** | Each agent has `temperature` in registry |
| 5 | Health port fix | **DONE** | Dedicated `core/health-server.js` |
| 6 | Memory dedup (openclaw vs LanceDB) | **PARTIAL** | LanceDB is primary but `openclaw-memory.js` still used by Architect |
| 7 | Agent-to-agent bus | **DONE** | Redis pub/sub with typed channels |
| 8 | Unit tests | **MINIMAL** | 3 smoke tests + 2 core module tests only |
| 9 | Prompt versioning | **DONE** | Auditor writes to `prompts/versions/` |
| 10 | TypeScript migration | **NOT STARTED** | Still pure JS |
| 11 | Wolf live market data | **NOT STARTED** | No market data API integration |
| 12 | CFOBot SMS data | **DONE** | `sms-reader.js` pipeline active |
| 13 | Dashboard | **DONE** | Full-featured with WebSocket, charts, config editor |
| 14 | SahibaBot encryption | **NOT STARTED** | Sensitive data in plaintext |
| 15 | CareerBot | **DONE** | `agents/12-careerbot.js` with GitHub tools |

---

## TIER 1 — Critical / Do Now (Sprint 4-5, Weeks 1-4)

### 1. Fix Prompt Drift & Repetition Crisis
**Priority: URGENT | Effort: Low | Impact: High**

The auditor's reflection system has caused severe prompt degradation. Evidence from `prompts/00-architect.txt`:
- Line 3: "Provide concrete evidence or data to support the alignment..." repeated **6 times** in one sentence
- Lines 36-37: "Ensure that all outputs are complete and not cut off mid-sentence" repeated **6 times**
- Duplicate "Reflection Update" sections (W10, W11) that say the same thing

This is actively wasting context window tokens and confusing models across ALL agent prompts.

**Fix:**
- Add a `promptLint()` function in the auditor that detects and removes duplicate sentences before committing changes
- Before applying any reflection update, check cosine similarity of new text against existing prompt sections
- Add a max prompt size budget per agent (e.g., 2000 tokens)
- **Immediately:** manually clean all 12 prompt files to remove existing duplicates

**Files:** `agents/11-auditor.js`, `agents/99-slack-gateway.js` (lines 885-946), all `prompts/*.txt`

---

### 2. Deprecate openclaw-memory.js
**Priority: High | Effort: Low | Impact: Medium**

Two parallel memory systems still exist. `00-architect.js` (line 12) imports `readRecentContext`, `readTodayScreenActivity`, `readTodayAudioTranscripts` from `openclaw-memory.js` — a filesystem-based markdown store that duplicates what LanceDB already holds.

**Fix:**
- Replace the 3 function calls in `agents/00-architect.js` with equivalent `searchAllContext()` calls from `core/memory.js`
- Mark `core/openclaw-memory.js` as deprecated
- Verify `ingest-context.js` writes to LanceDB `context_feed` table (it does)

**Files:** `core/openclaw-memory.js`, `agents/00-architect.js`

---

### 3. Embedding Cache with TTL
**Priority: High | Effort: Low | Impact: Medium (cost + latency)**

Every `searchMemory()`, `searchScreenContext()`, and `addMemory()` call hits OpenRouter for embeddings. The same queries (e.g., each agent's `contextQuery` from the registry) get re-embedded on every `run()`. The morning brief alone generates 10+ embedding requests.

**Fix:**
- Add an LRU cache (npm `lru-cache`) in `core/memory.js` keyed on first 200 chars of text
- TTL: 6 hours for query embeddings, 24 hours for content embeddings
- Persist cache to file on graceful shutdown, reload on startup
- Estimated savings: 30-50% of embedding API calls

**Files:** `core/memory.js` (function `getEmbedding`)

---

### 4. SahibaBot Data Encryption
**Priority: High | Effort: Low | Impact: Medium (risk reduction)**

Relationship data (WhatsApp drafts, promises, date plans) stored in plaintext SQLite and backed up unencrypted to Google Drive.

**Fix:**
- Use Node.js `crypto.createCipheriv` with AES-256-GCM on the `03_SAHIBA` namespace
- Encryption key from env variable `SAHIBA_ENCRYPTION_KEY`
- Wrap `addConversationMessage` and `getRecentConversation` for the sahibabot namespace
- Add `SENSITIVE: true` flag to registry namespaces excluded from cloud backup

**Files:** `core/db.js`, `core/filesystem.js`, `agents/03-sahibabot.js`

---

### 5. Proactive Intelligence Engine
**Priority: Critical | Effort: Medium | Impact: Very High**

Currently only Architect (morning/evening briefs) and Watchtower run proactively. The other 11 agents sit idle until asked via Slack. A "chief of staff" should anticipate needs, not wait to be asked.

**Fix:**
- Add a `proactiveChecks` array to each agent's registry config
- Each check: `{ cron, gatherFn, conditionFn, priority }` — only dispatches to `agent.run()` when the condition fires
- New `core/proactive.js` module manages scheduling and dispatch
- Start with:
  - **BioBot:** 3 PM step nudge, craving intervention when screen shows stress keywords
  - **CFOBot:** daily spending velocity check vs weekly budget
  - **SahibaBot:** anniversary/date reminders from calendar
  - **EdmoBot:** standup reminder if no Jira update by 10 AM

**Files:** `core/agent.js`, `core/registry.js`, new `core/proactive.js`

---

### 6. Intelligent Model Routing
**Priority: High | Effort: Medium | Impact: High (cost savings)**

Every request uses the agent's fixed model regardless of complexity. "What's the weather?" costs the same as "analyze my sprint velocity trends."

**Fix:**
- Add `routeModel(userMessage, agentConfig)` in `core/agent.js`
- Classify complexity by message length, tool requirements, and keyword heuristics
- Route: low complexity -> mistral-small, medium -> agent's default, high -> upgrade model
- Track per-tier token spend to refine routing over time

**Files:** `core/agent.js`, `core/bottleneck.js`, `core/registry.js`

---

## TIER 2 — High Priority (Sprint 6-7, Weeks 5-8)

### 7. Comprehensive Test Suite
**Effort: High | Impact: Very High**

Only 3 smoke tests exist for a system that autonomously sends messages, creates tickets, controls appliances, and manages finances. Priority test targets:
1. `core/bottleneck.js` — budget enforcement, circuit breaker, tier pausing
2. `core/agent.js` — tool call loop (mock LLM), retry logic, context truncation
3. `core/db.js` — all CRUD operations, transaction recording
4. `core/bus.js` — publish/subscribe, payload serialization
5. `scripts/audio-triage.js` — LLM classification parsing, action item extraction

**Files:** `tests/`, `vitest.config.js`

---

### 8. Cross-Agent Collaboration Workflows
**Effort: High | Impact: Very High | Depends on: #5 (Proactive Engine)**

The bus exists but only carries fire-and-forget events. No orchestration layer chains agents together.

**Fix:**
- New `core/workflow.js` with simple DAG-based workflow engine
- Define workflows as JSON: trigger event -> sequence of agent actions with payload transforms
- Starter workflows:
  - **Meeting-to-tickets:** Audio triage detects work meeting -> EdmoBot creates Jira tickets from action items
  - **Health-to-environment:** BioBot detects low HRV -> Architect reduces priorities / Jarvis adjusts room
  - **Spending-alert-cascade:** CFOBot detects overspend -> Architect adjusts day plan

**Files:** `core/bus.js`, new `core/workflow.js`

---

### 9. Decision Journal & Retrospectives
**Effort: Medium | Impact: High**

The system logs runs and transactions but has no concept of "decisions." When CFOBot flags an expense or the Auditor changes a prompt, there's no way to review if those decisions were good.

**Fix:**
- New SQLite table `decisions`: `id, agent, category, decision_text, rationale, outcome, score, reviewed_at`
- Agents log decisions via `db.addDecision()` when recommending actions
- Auditor's weekly reflection includes a decision review pass
- Dashboard page to browse and annotate decisions

**Files:** `core/db.js`, `agents/11-auditor.js`, `scripts/dashboard.js`

---

### 10. Network / Relationship CRM
**Effort: Medium | Impact: High**

SahibaBot handles one relationship. SocialBot only drafts replies. Nobody tracks the full social graph across emails, WhatsApp, meetings, and audio.

**Fix:**
- New SQLite table `contacts`: `name, platform, last_contact, contact_count, topics_json, follow_ups_json`
- GWS-sync and Hermes-bridge already provide email/message data; extract contact names post-processing
- Audio triage already extracts `participants` — feed into contacts table
- SocialBot evolves to surface: "You haven't talked to X in 30 days", "Y promised a proposal — follow up?"

**Files:** `core/db.js`, `agents/04-socialbot.js`, `scripts/audio-triage.js`, `scripts/gws-sync.js`

---

### 11. Meeting Preparation & Follow-Up
**Effort: Medium | Impact: High | Depends on: #5, #10**

Calendar events are synced, audio triage extracts action items, email context exists in memory — but nothing stitches them into pre-meeting prep.

**Fix:**
- Proactive engine triggers 30 min before each calendar event
- Query: attendee names -> contacts CRM -> recent emails/messages with them -> open action items
- Post structured brief to relevant agent's Slack channel
- After meeting: cross-reference new audio triage results with prep brief for follow-up tracking

**Files:** `core/gws.js`, `scripts/audio-triage.js`, `core/proactive.js`

---

## TIER 3 — Medium Priority (Sprint 8-10, Weeks 9-16)

### 12. Goal Tracking & Accountability System
**Effort: Medium | Impact: High**

The Architect prompt mentions 3 macro goals (marriage, debt, health) but there's no structured tracking. `goal_tracker` state stores only today's spend.

**Fix:**
- New SQLite table `goals`: `id, category, target_value, current_value, deadline, milestones_json, updated_at`
- Architect's evening summary updates goal progress from other agents' outputs
- Dashboard page with visual progress bars
- Weekly goal review in auditor: "Debt payoff 3% ahead of schedule"

**Files:** `core/db.js`, `agents/00-architect.js`, `scripts/dashboard.js`

---

### 13. Time Blocking & Deep Work Protection
**Effort: Medium | Impact: High | Depends on: #8**

The system interrupts equally whether you're in a 1:1 or deep coding flow.

**Fix:**
- New `agent_state` key: `system.mode` — values: `normal`, `deep_work`, `meeting`, `sleep`
- Mode transitions via calendar events, Slack commands, or Jarvis automation
- In `deep_work` mode, non-urgent messages queue instead of posting to Slack
- Queue flushes when mode returns to `normal`

**Files:** `core/db.js`, `agents/99-slack-gateway.js`

---

### 14. Habit Formation Tracker
**Effort: Low | Impact: Medium**

BioBot's prompt mentions quit tracking but there's no structured habit storage. Streaks and milestones are powerful motivators.

**Fix:**
- New SQLite table `habits`: `id, name, category, streak_current, streak_best, last_completed, total_completions`
- Auto-mark some habits from Apple Health (steps, sleep)
- Manual check-ins via Slack for others (meditation, water)
- Morning brief includes habit status; streak milestones trigger celebration messages

**Files:** `core/db.js`, `agents/07-biobot.js`

---

### 15. Pattern Learning from User Behavior
**Effort: Medium | Impact: High**

Nobody analyzes recurring patterns in the user's behavior across screen activity, transactions, and calendar.

**Fix:**
- Weekly batch job analyzing screen activity, transactions, calendar patterns
- Store patterns in `agent_state` as JSON: `{pattern: "late_night_food_order", days: ["fri","sat"], confidence: 0.85}`
- Inject relevant patterns into agent system prompts as "Known Behavioral Patterns"
- Auditor reviews and prunes patterns during weekly reflection

**Files:** `core/memory.js`, `agents/11-auditor.js`

---

### 16. Wolf Live Market Data
**Effort: Medium | Impact: High (for Wolf)**

Wolf's F&O analysis uses Perplexity for "data" — all analysis is LLM-inferred, not real prices. Paper trades are fiction.

**Fix:**
- Integrate NSE India API or Zerodha Kite Connect for live Nifty/BankNifty data
- New `core/market-data.js`: `getOptionChain(symbol)`, `getLTP(symbol)`, `getHistorical(symbol, range)`
- Add as tools to Wolf in the gateway
- Store paper trades with actual API prices

**Files:** `agents/09-wolf.js`, new `core/market-data.js`

---

### 17. Content Consumption Manager
**Effort: Medium | Impact: Medium**

Screenpipe captures what apps are used but nobody analyzes consumption patterns.

**Fix:**
- Post-process screen activity to classify by app and content type
- New `content_log` table: `url_or_title, app, category, duration_estimate, date`
- Weekly summary: "4 hours YouTube, 2 hours Twitter, 30 min technical articles"
- Integration with BioBot for digital wellness tracking

**Files:** `core/memory.js`, `scripts/ingest-context.js`

---

### 18. Email Management Automation
**Effort: Medium | Impact: High**

Email tools exist but there's no intelligent triage. No "3 emails need response, 12 are FYI, 5 are spam."

**Fix:**
- Add LLM classification step during GWS-sync: `action_required`, `fyi`, `promotional`, `automated`
- Daily email digest with counts per category
- Auto-draft acknowledgment responses for FYI emails
- Surface action-required emails in Architect's morning brief

**Files:** `scripts/gws-sync.js`, `core/gws.js`

---

### 19. Mobile Access via Telegram
**Effort: Medium | Impact: Medium**

Slack mobile is heavy and notification-noisy. Telegram is lighter and supports inline keyboards for approvals.

**Fix:**
- Leverage existing Hermes Telegram bridge
- Add Telegram message handler in gateway mirroring Slack dispatch
- Support same `hydra <agent> <message>` syntax
- Use inline keyboards for approve/reject flows

**Files:** `core/hermes-bridge.js`, `agents/99-slack-gateway.js`

---

## TIER 4 — Lower Priority / Longer-Term (Sprint 11+)

### 20. Semantic Memory Deduplication
**Effort: Medium | Impact: Medium | Depends on: #3**

Every `agent.run()` adds a memory entry. Many are near-duplicates that crowd out distinct memories.

**Fix:** Before inserting, search top-1 similar memory. If cosine similarity > 0.95, update timestamp instead of inserting. Weekly auditor batch to merge memories > 0.90 similarity.

---

### 21. Response Caching for Repeated Queries
**Effort: Low | Impact: Medium**

"How much did I spend today?" asked 3 times costs 3x tokens. Cache non-tool-call LLM responses in Redis with 15-min TTL.

---

### 22. Structured Error Recovery & Replay
**Effort: Medium | Impact: Medium**

When an agent run fails mid-tool-call, the user's intent is lost. Persist failed runs to `failed_runs` table, retry with exponential backoff.

---

### 23. Document Knowledge Base
**Effort: Medium | Impact: Medium**

A `scripts/doc-ingest.js` pipeline that watches a folder, parses PDFs, chunks, embeds into `context_feed` so agents can answer questions about contracts, tax papers, learning materials.

---

### 24. TypeScript Migration (Incremental)
**Effort: High | Impact: Medium (long-term) | Depends on: #7**

Start with `.d.ts` declarations for `Agent`, `Tool`, `AgentConfig`. Migrate `core/registry.js` and `core/db.js` first. Use `tsc --noEmit` in CI.

---

### 25. BrandBot Content Calendar & Auto-Posting
**Effort: Medium | Impact: Medium**

Weekly cron: BrandBot analyzes work logs and GitHub contributions, generates 2-3 LinkedIn draft posts, queues for approval via Slack buttons.

---

### 26. Agent Hot-Reload via Bus
**Effort: Low | Impact: Medium**

Replace fragile file-based `EVICT_FILE` mechanism with Redis bus event `agent.reconfigure`. Dashboard posts event instead of writing evict file.

---

### 27. Backup Verification & Restore Testing
**Effort: Low | Impact: Medium**

After each backup, verify file integrity via checksum. Monthly automated restore test. Watchtower alert if backup hasn't completed in 24 hours.

---

### 28. Travel Planning Capability
**Effort: Medium | Impact: Medium**

Add travel research tools to Architect using web search APIs. Store trip plans in `agent_state`. BioBot integration for fitness prep, CFOBot for budget impact.

---

### 29. BioBot + Jarvis Sleep Automation
**Effort: Low | Impact: Medium | Depends on: #13, #5**

BioBot publishes `health.bedtime` on bus -> Jarvis triggers sleep mode (dim lights, AC, DND) -> SocialBot queues messages. Reverse on `health.wakeup`.

---

### 30. End-to-End Distributed Tracing
**Effort: Medium | Impact: Medium | Depends on: #8**

Assign `traceId` to every Slack message, pass through `agent.run()`, include in bus events, log in every agent. Dashboard page to search by traceId.

---

### 31. Agent Dependency Graph Visualization
**Effort: Low | Impact: Low**

D3.js force-directed graph in dashboard showing agents as nodes, bus channels as edges. Color by tier, size by spend.

---

### 32. Cron Schedule Calendar Dashboard
**Effort: Low | Impact: Low**

Visual timeline showing when each agent/script cron fires. Highlight overlaps and budget-heavy windows.

---

### 33. Dashboard Multi-User Auth
**Effort: Low | Impact: Low**

Replace hardcoded credentials with bcrypt-hashed passwords in SQLite. Two roles: admin (full control) and viewer (read-only). Session expiry. Audit log.

---

### 34. Voice-First Interaction Loop
**Effort: High | Impact: Medium**

Route short Plaud "command" recordings directly to agent dispatch for voice-driven interaction. Whisper.cpp for near-real-time transcription. Optional TTS response.

---

### 35. Proactive BioBot Agent File
**Effort: Medium | Impact: High | Depends on: #5**

Create proper `agents/07-biobot.js` with cron schedules: morning readiness (6:30 AM), afternoon step check (3 PM), evening summary (9 PM). Read Apple Health data proactively.

---

## Recommended Sprint Plan

| Sprint | Weeks | Items | Theme |
|--------|-------|-------|-------|
| **Sprint 4** | 1-2 | #1, #2, #3, #4 | **Cleanup & Quick Wins** — fix prompt drift, remove dead memory system, add caching, encrypt sensitive data |
| **Sprint 5** | 3-4 | #5, #6 | **Force Multipliers** — proactive intelligence engine + intelligent model routing |
| **Sprint 6** | 5-6 | #7, #9 | **Foundations** — test suite + decision journal |
| **Sprint 7** | 7-8 | #8, #10, #11 | **Cross-Agent Intelligence** — workflows, CRM, meeting prep |
| **Sprint 8** | 9-10 | #12, #13, #14 | **Life Management** — goals, deep work mode, habits |
| **Sprint 9** | 11-12 | #15, #16, #17 | **Pattern Intelligence** — behavior learning, market data, content tracking |
| **Sprint 10** | 13-14 | #18, #19 | **Communication** — email automation, Telegram access |
| **Sprint 11+** | 15+ | #20-35 | **Polish & Scale** — memory dedup, TypeScript, tracing, voice |

---

## Priority Matrix (sorted by Priority Score = Impact x Inverse Effort)

| Rank | # | Improvement | Effort | Impact | Score |
|------|---|-------------|--------|--------|-------|
| 1 | 1 | Prompt Drift Fix | Low | High | **Top** |
| 2 | 2 | Deprecate openclaw-memory | Low | Medium | **Top** |
| 3 | 3 | Embedding Cache | Low | Medium | **Top** |
| 4 | 4 | SahibaBot Encryption | Low | Medium | **Top** |
| 5 | 5 | Proactive Intelligence | Medium | Very High | **Top** |
| 6 | 6 | Intelligent Model Routing | Medium | High | **High** |
| 7 | 7 | Test Suite | High | Very High | **High** |
| 8 | 8 | Cross-Agent Workflows | High | Very High | **High** |
| 9 | 9 | Decision Journal | Medium | High | **High** |
| 10 | 10 | Relationship CRM | Medium | High | **High** |
| 11 | 11 | Meeting Prep | Medium | High | **High** |
| 12 | 12 | Goal Tracking | Medium | High | **Medium** |
| 13 | 13 | Deep Work Mode | Medium | High | **Medium** |
| 14 | 14 | Habit Tracker | Low | Medium | **Medium** |
| 15 | 15 | Pattern Learning | Medium | High | **Medium** |
| 16 | 16 | Wolf Market Data | Medium | High | **Medium** |
| 17 | 17 | Content Manager | Medium | Medium | **Medium** |
| 18 | 18 | Email Automation | Medium | High | **Medium** |
| 19 | 19 | Telegram Bot | Medium | Medium | **Medium** |
| 20-35 | 20-35 | Tier 4 items | Various | Various | **Lower** |

---

*Generated: 2026-03-09*
