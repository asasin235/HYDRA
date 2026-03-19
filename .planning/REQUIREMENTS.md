# Requirements: HYDRA

**Defined:** 2026-03-20
**Core Value:** HYDRA must reliably turn personal and work context into low-overhead, human-supervised action through one local system.

## v1 Requirements

### Architecture

- [ ] **ARCH-01**: Operator dashboard frontend is delivered as a dedicated React + TypeScript application instead of inline HTML inside `scripts/dashboard.js`
- [ ] **ARCH-02**: Dashboard backend exposes typed Node.js API contracts for operator workflows
- [ ] **ARCH-03**: New dashboard/backend modules follow a functional architecture with pure domain logic separated from IO adapters

### Operator Experience

- [ ] **OPER-01**: Operator can authenticate into a stable dashboard shell and navigate between review, runtime, and metrics surfaces

### Review Queue

- [ ] **REVQ-01**: Operator can view review queue items with filters, counts, and normalized lifecycle states
- [ ] **REVQ-02**: Operator can open a review item and see raw transcript, normalized summary, classification, participant context, and notes

### Review Actions

- [ ] **APPR-01**: Operator can save draft review edits without triggering downstream ingest
- [ ] **APPR-02**: Operator can approve a review item and trigger downstream ingest/index behavior exactly once
- [ ] **APPR-03**: Operator can archive/disapprove a review item while preserving audit history

### Ingestion Compatibility

- [ ] **ING-01**: Audio entering active ingest paths is queued into `needs_review` and becomes visible in the dashboard without manual repair

### Runtime Operations

- [ ] **OPS-01**: Operator can inspect PM2 service health, recent logs, spend, and key queue metrics from the dashboard
- [ ] **OPS-02**: Operator can start, stop, and restart supported HYDRA services from the dashboard

### Migration Quality

- [ ] **MIG-01**: New dashboard/backend coexists with the current HYDRA runtime and reuses existing Node.js, PM2, SQLite, LanceDB, Redis, and `BRAIN_PATH` infrastructure
- [ ] **QUAL-01**: Automated tests cover critical dashboard API and review-queue flows that are vulnerable to schema/contract drift

## v2 Requirements

### Dashboard Expansion

- **DASH-01**: Operator receives live streaming updates for logs and selected runtime panels where polling is insufficient
- **DASH-02**: Legacy secondary dashboard surfaces (memory browser, prompt editor, historical views) are migrated into the new React shell

### Platform Hardening

- **PLAT-01**: Dashboard supports multi-user roles and stronger audit permissions
- **PLAT-02**: HYDRA core/agent/dashboard shared modules are progressively migrated to TypeScript where it reduces operational risk

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing Slack as HYDRA’s primary conversational UI | Conflicts with a documented HYDRA design principle and is not required for the dashboard rewrite |
| Replatforming HYDRA to cloud or Kubernetes | Violates the single-host simplicity goal and expands scope far beyond the dashboard milestone |
| Whole-repo rewrite to TypeScript in the same milestone | Too much brownfield change at once; dashboard/backend boundary gives better leverage first |
| Full parity rewrite of every legacy dashboard page before shipping | Delays operator-critical review/runtime improvements |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARCH-02 | Phase 1 | Pending |
| ARCH-03 | Phase 1 | Pending |
| MIG-01 | Phase 1 | Pending |
| ARCH-01 | Phase 2 | Pending |
| OPER-01 | Phase 2 | Pending |
| REVQ-01 | Phase 3 | Pending |
| REVQ-02 | Phase 3 | Pending |
| ING-01 | Phase 3 | Pending |
| APPR-01 | Phase 4 | Pending |
| APPR-02 | Phase 4 | Pending |
| APPR-03 | Phase 4 | Pending |
| OPS-01 | Phase 5 | Pending |
| OPS-02 | Phase 5 | Pending |
| QUAL-01 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-20*
*Last updated: 2026-03-20 after initial definition*
