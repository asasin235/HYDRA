# Roadmap: HYDRA

## Overview

HYDRA already has validated ingestion, memory, agent, and PM2 runtime foundations. The next brownfield roadmap modernizes the operator dashboard into a React + TypeScript frontend with a functional Node backend, starting with contract-safe backend boundaries and ending with a stable browser cockpit for review queue work, runtime operations, and operational metrics.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Functional Backend Foundation** - Typed Node contracts and adapter boundaries for the dashboard rewrite
- [ ] **Phase 2: React Operator Shell** - React + TypeScript shell, auth flow, and navigation for operator workflows
- [ ] **Phase 3: Review Queue Read Flows** - Normalized queue/detail reads and ingest visibility in the new dashboard
- [ ] **Phase 4: Approval Workflow Hardening** - Safe save/approve/archive actions for reviewed-memory workflows
- [ ] **Phase 5: Runtime Ops and Cutover Quality** - PM2 controls, metrics, tests, and migration hardening for the new operator surface

## Phase Details

### Phase 1: Functional Backend Foundation
**Goal**: Deliver a typed Node backend layer that normalizes dashboard contracts and isolates brownfield side effects behind adapters.
**Depends on**: Nothing (first phase)
**Requirements**: [ARCH-02, ARCH-03, MIG-01]
**Success Criteria** (what must be TRUE):
  1. Dashboard operator APIs return normalized typed DTOs instead of raw legacy row shapes
  2. Review/runtime domain logic is implemented in functional modules separated from PM2/DB/filesystem adapters
  3. The new backend can run on the existing HYDRA host/runtime without replatforming the system
**Plans**: 3 plans

Plans:
- [x] 01-01: Inventory legacy dashboard routes and define typed operator/review contracts
- [x] 01-02: Split functional domain modules from backend adapters for review and runtime flows
- [x] 01-03: Wire backend bootstrap into the existing Node/PM2 environment with brownfield-safe boundaries

### Phase 2: React Operator Shell
**Goal**: Deliver the React + TypeScript dashboard shell, authentication flow, and navigation for the new operator experience.
**Depends on**: Phase 1
**Requirements**: [ARCH-01, OPER-01]
**Success Criteria** (what must be TRUE):
  1. Operator can log in and reach the new React dashboard shell
  2. Operator can navigate between review, runtime, and metrics sections from one UI
  3. The new shell consumes typed backend contracts rather than legacy HTML responses
**Plans**: 3 plans

Plans:
- [ ] 02-01: Scaffold the React + TypeScript application and shared client contracts
- [ ] 02-02: Implement auth/session handling and top-level operator layout
- [ ] 02-03: Add route structure and shared UI primitives for dashboard surfaces

### Phase 3: Review Queue Read Flows
**Goal**: Make review queue data reliably visible in the React dashboard, including normalized item details and ingest visibility.
**Depends on**: Phase 2
**Requirements**: [REVQ-01, REVQ-02, ING-01]
**Success Criteria** (what must be TRUE):
  1. Operator can browse review queue items with correct lifecycle states and counts
  2. Operator can open an item and inspect transcript, summary, classification, participant context, and notes
  3. New audio queued through active ingest paths appears in the review dashboard without manual intervention
**Plans**: 3 plans

Plans:
- [ ] 03-01: Build queue list/count endpoints and React list filters against normalized review data
- [ ] 03-02: Build review detail endpoints and React detail screens for transcript/summary/classification context
- [ ] 03-03: Normalize ingest-to-queue visibility so active pipelines surface `needs_review` items correctly

### Phase 4: Approval Workflow Hardening
**Goal**: Make the reviewed-memory action flows safe, auditable, and usable from the new dashboard.
**Depends on**: Phase 3
**Requirements**: [APPR-01, APPR-02, APPR-03]
**Success Criteria** (what must be TRUE):
  1. Operator can save draft edits without triggering ingest
  2. Operator can approve an item and downstream ingest/index runs exactly once
  3. Operator can archive/disapprove an item and audit history remains intact
**Plans**: 3 plans

Plans:
- [ ] 04-01: Implement draft save/archive command routes and frontend mutations
- [ ] 04-02: Harden approve flow and approval pipeline integration for idempotent execution
- [ ] 04-03: Add action feedback, audit details, and failure handling around review mutations

### Phase 5: Runtime Ops and Cutover Quality
**Goal**: Complete the operator cockpit with runtime controls, metrics, and test coverage so the new dashboard can replace the old operator paths.
**Depends on**: Phase 4
**Requirements**: [OPS-01, OPS-02, QUAL-01]
**Success Criteria** (what must be TRUE):
  1. Operator can inspect PM2 health, logs, spend, and queue metrics from the new dashboard
  2. Operator can start, stop, and restart supported services through the browser UI
  3. Automated tests protect critical dashboard API and review queue flows from schema/contract drift
**Plans**: 3 plans

Plans:
- [ ] 05-01: Implement runtime metrics/process-control backend endpoints and React ops views
- [ ] 05-02: Add contract/integration tests for review queue and operator APIs
- [ ] 05-03: Cut over the operator-critical paths from legacy dashboard routes to the new dashboard

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Functional Backend Foundation | 3/3 | Complete | 2026-03-20 |
| 2. React Operator Shell | 0/3 | Not started | - |
| 3. Review Queue Read Flows | 0/3 | Not started | - |
| 4. Approval Workflow Hardening | 0/3 | Not started | - |
| 5. Runtime Ops and Cutover Quality | 0/3 | Not started | - |
