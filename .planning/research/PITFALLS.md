# Pitfalls Research

**Domain:** brownfield dashboard migration for reviewed-memory and operator workflows
**Researched:** 2026-03-20
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: Schema / Naming Drift Between Queue Storage and UI Contracts

**What goes wrong:**
The frontend/backend/dashboard code disagree on fields like `status` vs `review_state` or `review_notes` vs `reviewer_notes`, so review actions appear to work while the underlying workflow breaks.

**Why it happens:**
Brownfield route handlers evolve faster than shared storage helpers, and raw DB rows leak through the stack.

**How to avoid:**
Introduce a single contract-normalization layer and require all review routes to map through it.

**Warning signs:**
UI renders but queue counts are wrong, actions “succeed” without visible state change, or tests/assertions use multiple vocabularies for the same concept.

**Phase to address:**
Phase 1 and Phase 3

---

### Pitfall 2: Frontend Rewrite Without Safe Backend Boundaries

**What goes wrong:**
The React app exists, but it still depends on server-rendered routes, implicit side effects, or direct shelling through untyped endpoints.

**Why it happens:**
Teams focus on visual migration before they define stable backend contracts.

**How to avoid:**
Build typed backend contracts and adapter boundaries before or alongside the frontend shell.

**Warning signs:**
React pages need route-specific hacks, duplicate transformation logic, or frontend code starts encoding PM2/DB assumptions directly.

**Phase to address:**
Phase 1 and Phase 2

---

### Pitfall 3: Approval Actions That Are Not Idempotent

**What goes wrong:**
Approve/archive operations double-run, partially ingest, or mutate audit state incorrectly.

**Why it happens:**
Action handlers combine UI concerns, DB writes, and ingest side effects without explicit transition guards.

**How to avoid:**
Treat actions as backend commands with checked transitions, explicit error paths, and integration tests.

**Warning signs:**
Duplicate indexed records, queue items disappearing, or approval routes crashing dashboard startup.

**Phase to address:**
Phase 4

---

### Pitfall 4: Rewriting Too Much of the Dashboard at Once

**What goes wrong:**
Critical operator workflows regress because the migration includes memory browsers, prompt editors, and non-essential panels before the core review/runtime paths are stable.

**Why it happens:**
A full rewrite feels cleaner than a focused migration.

**How to avoid:**
Ship operator-critical surfaces first and defer broad parity until the new shell is proven.

**Warning signs:**
Roadmap phases balloon, requirements become generic, and no single release clearly improves the current operator pain.

**Phase to address:**
Phase 2 through Phase 5

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Reusing raw legacy route payloads | Faster initial UI hookup | Locks the React app to drift-prone shapes | Only as a temporary adapter behind typed DTOs |
| Keeping all new logic inside one backend file | Fast iteration | Recreates the `scripts/dashboard.js` monolith | Only for tiny bootstrap code, not domain logic |
| Skipping tests on review actions | Saves time initially | Breaks human approval flows silently | Never acceptable for approve/archive/save actions |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| PM2 | Exposing shell semantics directly to the UI | Keep PM2 interaction in backend adapters and return typed statuses |
| SQLite review queue | Updating whichever field name a caller happens to send | Normalize inputs and write canonical storage columns |
| Approval pipeline | Importing or invoking pipeline code in a way that crashes dashboard boot | Keep startup paths isolated and validate pipeline dependencies with tests |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Reloading whole pages for every queue action | Slow operator experience | Use targeted data fetching and mutation invalidation | Shows up as soon as queue traffic becomes routine |
| Over-streaming logs/metrics | Excessive backend work and noisy UI | Poll most panels and stream only high-value feeds | Breaks once many panels subscribe concurrently |
| Running expensive derived queries in render paths | Slow list/detail views | Pre-shape payloads in backend/domain layer | Breaks on larger queue/history datasets |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Weak dashboard auth assumptions | Operator panel exposed to unintended users/devices | Keep auth enabled and document session expectations |
| Mixing operator actions with unaudited side effects | Loss of accountability on approvals/process control | Return audit-friendly action results and log mutations |
| Exposing raw filesystem or shell access via dashboard routes | Escalation beyond intended PM2/operator controls | Narrow backend APIs to specific allowed operations |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Ambiguous state labels | Operators cannot tell whether an item needs review, is reviewed, or is indexed | Normalize lifecycle language and show it consistently |
| Too much data on one screen | Review becomes slow and error-prone | Separate list, detail, and action affordances cleanly |
| Controls with unclear consequences | Operators fear using approve/archive/restart actions | Use explicit labels, confirmations where needed, and visible status feedback |

## "Looks Done But Isn't" Checklist

- [ ] **Review queue:** Filters and counts match the same normalized lifecycle states
- [ ] **Review detail:** Transcript, summary, classification, and notes all load from the same review item context
- [ ] **Approval flow:** Approve triggers the downstream ingest path exactly once and updates UI state correctly
- [ ] **Runtime controls:** Process-control buttons reflect real PM2 outcomes, not optimistic UI only
- [ ] **Migration:** New dashboard can replace old operator paths without breaking Slack-first runtime behavior

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Contract drift | MEDIUM | Reintroduce a canonical DTO layer and backfill tests around affected endpoints |
| Broken approval action | HIGH | Disable action route, preserve queue rows, fix transition logic, and replay with explicit checks |
| Over-scoped rewrite | MEDIUM | Cut non-critical pages from the current milestone and refocus on operator-critical surfaces |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Contract drift | Phase 1 | Contract tests cover read/write review payloads |
| Unsafe frontend/backend coupling | Phase 1-2 | React app only consumes typed backend DTOs |
| Broken approval semantics | Phase 4 | Integration tests prove save/approve/archive behavior |
| Overscoped migration | Phase 5 | Rollout checklist limits launch to operator-critical surfaces |

## Sources

- [📓 Dev Logs](https://www.notion.so/31db31d7af7a81afbdc4e7aadcb2263c)
- Local dashboard/review/approval code inspection in the HYDRA repo

---
*Pitfalls research for: brownfield dashboard migration for reviewed-memory and operator workflows*
*Researched: 2026-03-20*
