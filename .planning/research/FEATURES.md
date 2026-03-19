# Feature Research

**Domain:** operator dashboard and human-review tooling for HYDRA
**Researched:** 2026-03-20
**Confidence:** MEDIUM

## Feature Landscape

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Authenticated dashboard access | Operator surfaces need at least basic access control | LOW | Existing dashboard already uses session auth; keep or improve it |
| Process health and controls | Operators expect to see whether critical services are up and to restart them | MEDIUM | Must integrate with PM2 safely |
| Review queue list/detail | Human-reviewed memory flows are unusable without a queue browser | MEDIUM | Existing code already contains queue/detail routes to modernize |
| Safe approve/archive actions | Review tooling is incomplete without final actions | HIGH | Must preserve audit semantics and avoid double-ingest |
| Metrics and recent logs | Operators need enough observability to debug the system from one place | MEDIUM | Should include spend/queue/process signals, not only raw logs |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Unified review + runtime cockpit | One browser surface for operator-critical HYDRA workflows | MEDIUM | Strong fit for the current migration goal |
| Contract-normalized reviewed-memory tooling | Removes naming drift and schema mismatch from queue flows | HIGH | Improves both product reliability and developer velocity |
| Brownfield-safe migration path | Replace the dashboard without destabilizing the rest of HYDRA | MEDIUM | Important because the system already runs live agents and pipelines |
| Functional domain architecture | Easier reasoning, testability, and less stateful drift in the new implementation | MEDIUM | Aligns directly with the user request |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full rewrite of every dashboard view in one phase | Feels “cleaner” to rebuild everything at once | Bloats scope and delays the operator-critical review/runtime rewrite | Ship the operator/review surfaces first, migrate secondary pages later |
| Replacing Slack approvals entirely with dashboard-only flows | Centralizes all UX in one browser app | Breaks the documented Slack-first operating model and may strand existing workflows | Keep browser operator tools while preserving Slack as the primary command surface |
| Streaming every dashboard panel in real time | Feels modern and dynamic | Adds complexity and noise where polling is sufficient | Use polling by default, streaming only for logs/high-value status |

## Feature Dependencies

```text
React shell
    └──requires──> typed Node API
                           └──requires──> normalized queue/runtime contracts

Review actions
    └──requires──> correct approval pipeline behavior
                           └──requires──> audit-safe reviewed-memory state transitions

Runtime controls
    └──requires──> PM2 adapter layer
```

### Dependency Notes

- **React shell requires typed Node API:** The frontend rewrite only pays off if the data contracts stop drifting.
- **Review actions require approval pipeline correctness:** Approve/archive buttons are dangerous unless the backend enforces idempotent, auditable transitions.
- **Runtime controls require PM2 adapters:** The browser should call a narrow backend layer, not shell out directly from the frontend.

## MVP Definition

### Launch With (v1)

- [ ] Authenticated React dashboard shell — needed to replace the inline HTML surface
- [ ] Review queue list/detail — needed for operator approval work
- [ ] Safe save/approve/archive review actions — needed for real queue usage
- [ ] Runtime health, spend, and PM2 controls — needed for day-to-day operations
- [ ] Contract and test coverage for review/dashboard flows — needed to stop naming drift from recurring

### Add After Validation (v1.x)

- [ ] Live log streaming — add when polling-based log views prove insufficient
- [ ] Secondary dashboard surfaces (memory browser, prompt views) — add after the operator-critical rewrite stabilizes
- [ ] Better session management/hardening — add if multiple devices/operators become common

### Future Consideration (v2+)

- [ ] Multi-user roles and audit permissions — defer until HYDRA needs more than one trusted operator
- [ ] Full TypeScript migration across HYDRA core/agents — valuable, but larger than the dashboard milestone
- [ ] Replacing or rethinking the Slack/browser split — only after the new dashboard has proven itself

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Typed backend contracts | HIGH | MEDIUM | P1 |
| React dashboard shell | HIGH | MEDIUM | P1 |
| Review queue list/detail | HIGH | MEDIUM | P1 |
| Safe approval/archive actions | HIGH | HIGH | P1 |
| Runtime controls and metrics | HIGH | MEDIUM | P1 |
| Live streaming everywhere | MEDIUM | HIGH | P3 |
| Full dashboard parity with all legacy pages | MEDIUM | HIGH | P2 |
| Multi-user RBAC | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Competitor A | Competitor B | Our Approach |
|---------|--------------|--------------|--------------|
| Review queue | Typical internal moderation/audit tools expose list + detail + explicit state transitions | Admin consoles often expose queue triage with filtered lists and audit data | Build a focused review queue around HYDRA’s transcript/classification/approval model |
| Runtime controls | Internal ops panels expose service health and restart actions | DevOps dashboards expose metrics/logs but often assume cloud infra | Keep PM2-first operator controls tuned to a single-host personal AI system |
| Typed contracts | Modern admin apps use typed APIs to keep frontend/backend aligned | Older monoliths rely on ad hoc route payloads and drift over time | Prioritize typed contracts because naming drift is already a real issue in HYDRA |

## Sources

- [📓 Dev Logs](https://www.notion.so/31db31d7af7a81afbdc4e7aadcb2263c) — confirmed active pain around dashboard/API naming drift
- [🐉 HYDRA — Improvement Plan](https://www.notion.so/315b31d7af7a81cfa8decb408e6e8409) — confirmed browser dashboard as a meaningful backlog area
- Local repo review routes and current dashboard code — confirmed existing review queue/detail/operator surface patterns

---
*Feature research for: operator dashboard and human-review tooling for HYDRA*
*Researched: 2026-03-20*
