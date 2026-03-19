# Project Research Summary

**Project:** HYDRA
**Domain:** brownfield operator dashboard and reviewed-memory modernization
**Researched:** 2026-03-20
**Confidence:** MEDIUM

## Executive Summary

HYDRA is already a live single-host AI operating system with validated agent, ingestion, and memory infrastructure. The research does not point toward a platform rewrite; it points toward a controlled operator-surface modernization that introduces a React + TypeScript frontend and typed Node backend contracts around the dashboard while preserving the existing runtime, PM2 topology, SQLite/LanceDB state, and Slack-first interaction model.

The major risk is not “how to build a dashboard” but how to build one without repeating the current monolith’s contract drift. The most important architectural move is to add a normalization and contract layer between reviewed-memory storage/runtime adapters and the new UI. That allows the roadmap to focus on safe backend foundations first, then the React shell, then review and runtime features, with tests guarding approval and process-control flows before cutover.

## Key Findings

### Recommended Stack

The recommended stack is Node.js 22 + TypeScript + React + a modern frontend toolchain, while preserving current HYDRA storage/process/runtime foundations. The dashboard rewrite should not fork infrastructure; it should sit on top of existing Node/PM2/SQLite/LanceDB modules and add type-safe contracts around them.

**Core technologies:**
- **Node.js 22.x**: backend runtime — already required by HYDRA
- **TypeScript 5.x**: typed contracts and functional module boundaries — reduces drift in brownfield flows
- **React 19.x**: frontend UI layer — matches the requested browser rewrite
- **Vite**: frontend build/dev workflow — simple fit for a PM2-hosted operator app

### Expected Features

The dashboard domain here is an operator cockpit, not a generic admin panel. The must-have features are review queue list/detail, safe approve/archive/save actions, runtime process health/controls, and enough metrics/logs to operate HYDRA daily.

**Must have (table stakes):**
- Review queue list/detail and explicit stateful actions
- Authenticated operator shell
- Runtime health/process controls and key metrics

**Should have (competitive):**
- One coherent browser cockpit for review and runtime workflows
- Strong contract normalization around reviewed-memory data

**Defer (v2+):**
- Multi-user RBAC
- Full parity rewrite of every legacy dashboard surface
- Whole-repo TypeScript migration

### Architecture Approach

Use a strangler migration with a React frontend consuming typed Node APIs. Keep domain logic pure and isolate SQLite, PM2, filesystem, and pipeline side effects in adapters. The frontend should talk only to typed DTOs; the backend should be the only layer that knows about legacy queue/runtime shapes.

**Major components:**
1. **Typed backend contract layer** — normalizes queue/runtime data and actions
2. **React operator shell** — routes and screens for review/runtime/metrics workflows
3. **Brownfield adapters** — PM2, SQLite, review queue, transcript, and metrics integrations

### Critical Pitfalls

1. **Contract drift** — avoid with a canonical normalization layer and DTO tests
2. **Frontend-first rewrite without backend boundaries** — avoid by building the contract layer first
3. **Non-idempotent approval actions** — avoid by treating save/approve/archive as backend commands with tests
4. **Over-scoped migration** — avoid by shipping operator-critical surfaces before broad parity work

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Functional Backend Foundation
**Rationale:** The frontend rewrite will fail if the backend still leaks drift-prone shapes.
**Delivers:** Typed Node contracts, functional domain modules, and brownfield-safe adapter boundaries.
**Addresses:** Contract safety and migration safety.
**Avoids:** Schema drift and UI/backend coupling.

### Phase 2: React Operator Shell
**Rationale:** Once contracts exist, the new UI can land without guessing at backend behavior.
**Delivers:** React app shell, auth-aware navigation, and operator layout.
**Uses:** React, TypeScript, Vite, typed API clients.
**Implements:** Frontend shell and route composition.

### Phase 3: Review Queue Read Flows
**Rationale:** Read-only review flows provide the fastest usable operator value and prove the new architecture.
**Delivers:** Queue list/detail views and ingest normalization visibility.
**Uses:** Queue/transcript/classification adapters.
**Implements:** Review read models and queue visibility.

### Phase 4: Approval and Archive Actions
**Rationale:** Human-in-the-loop actions are the highest-risk product behavior and need dedicated hardening.
**Delivers:** Save, approve, and archive/disapprove workflows with audit-safe semantics.

### Phase 5: Runtime Ops, Metrics, and Cutover Quality
**Rationale:** Once review flows are stable, the operator cockpit can absorb runtime controls and become the default surface.
**Delivers:** PM2 controls, health/spend metrics, migration hardening, and test coverage.

### Phase Ordering Rationale

- Backend contracts come before frontend composition because drift is the primary current failure mode.
- Review read flows come before destructive or irreversible actions because they validate the data model safely.
- Runtime controls and migration hardening come last so the new operator surface can cut over with confidence.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** decide whether to stay inside the current dashboard process or split a dedicated backend app
- **Phase 4:** review approval/idempotency details against the evolving approval pipeline

Phases with standard patterns (skip research-phase):
- **Phase 2:** React app shell and route structure
- **Phase 3:** typed list/detail read flows

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Strong brownfield fit, but exact library choices can still be refined during planning |
| Features | HIGH | The required operator flows are clear from codebase + Notion + recent dev logs |
| Architecture | HIGH | The strangler + typed-contract approach directly addresses observed pain |
| Pitfalls | HIGH | Recent HYDRA work already exposed real examples of these failure modes |

**Overall confidence:** HIGH

### Gaps to Address

- Frontend packaging/serving choice: same PM2 process vs separate app
- Approval pipeline test depth and exact side-effect sequencing during approve/archive

## Sources

### Primary (HIGH confidence)
- Local HYDRA repo codebase and `.planning/codebase/*` analyses
- [🐉 HYDRA — Architecture & Objectives](https://www.notion.so/315b31d7af7a81c08d3ac03876782fed)
- [📓 Dev Logs](https://www.notion.so/31db31d7af7a81afbdc4e7aadcb2263c)

### Secondary (MEDIUM confidence)
- [🐉 HYDRA OS](https://www.notion.so/31db31d7af7a815fa1aecd5d6fda9e96)
- [🐉 HYDRA — Improvement Plan](https://www.notion.so/315b31d7af7a81cfa8decb408e6e8409)

---
*Research completed: 2026-03-20*
*Ready for roadmap: yes*
