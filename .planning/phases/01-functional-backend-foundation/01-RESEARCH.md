# Phase 1 Research: Functional Backend Foundation

**Phase:** 1 — Functional Backend Foundation
**Date:** 2026-03-20
**Inputs:** `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, project-level research, HYDRA codebase map, Notion architecture/objectives, dev logs

## Objective

Plan the backend foundation for the dashboard rewrite so the new React frontend can consume typed, normalized Node APIs instead of drift-prone legacy route payloads.

Phase requirements:
- `ARCH-02`
- `ARCH-03`
- `MIG-01`

## Current Brownfield Reality

- The existing dashboard lives in `scripts/dashboard.js` and mixes HTML rendering, auth, API routes, process control, ingest endpoints, and review routes in one runtime surface.
- Review-related data currently drifts between raw storage fields and UI-facing names. This has already caused broken review visibility and action semantics.
- HYDRA is explicitly single-host, PM2-managed, and Node.js 22 ESM. That host/runtime model is not being replaced in this milestone.
- The browser dashboard is operationally important, but Slack remains the primary conversational interface.

## Planning Conclusions

### 1. Backend boundary comes before frontend rewrite

The highest-risk problem is contract drift, not UI composition. The first phase should therefore create a typed backend seam that can:
- normalize reviewed-memory queue/detail/action payloads
- normalize runtime metrics/process-control payloads
- isolate PM2/SQLite/filesystem side effects behind adapters

### 2. Functional core is the right fit here

The new backend layer should use pure functions for:
- DTO shaping
- lifecycle/state normalization
- request-to-command translation
- metrics aggregation formatting

Imperative adapters should remain narrow and side-effecting:
- PM2 control/status execution
- DB reads/writes
- filesystem/log access
- HTTP framework glue

### 3. Strangler migration is safer than replacement

Phase 1 should not try to delete `scripts/dashboard.js`. It should instead establish:
- a new backend application boundary
- shared contracts
- brownfield-safe adapters
- integration points that allow later cutover

That keeps the runtime stable while future phases migrate operator flows.

## Proposed Architecture for This Phase

### New backend slices

- `dashboard/backend/contracts/`
  - Zod schemas and DTO types for queue/runtime/auth payloads
- `dashboard/backend/domains/`
  - pure functions for queue normalization, state transitions, metrics shaping
- `dashboard/backend/adapters/`
  - PM2, review queue, transcript, classification, and session adapters
- `dashboard/backend/routes/`
  - thin route handlers calling contracts + domains + adapters
- `dashboard/backend/server.ts`
  - backend entry and route composition

### Brownfield integration rules

- Reuse existing HYDRA storage/modules where practical instead of copying data.
- Keep any shell/PM2 execution strictly on the backend.
- Do not let the frontend know raw DB field names or PM2 command semantics.
- Avoid mixing new typed routes into large HTML handlers if a dedicated backend entry can be established cleanly.

## Risks

### Risk: TypeScript setup bleeds into whole repo

Mitigation:
- keep TS scope limited to dashboard/backend/shared directories
- use a dedicated tsconfig rather than a whole-repo migration

### Risk: Review contracts are normalized inconsistently

Mitigation:
- define DTO schemas first
- require route handlers to emit parsed DTOs only
- add contract tests in the same phase

### Risk: PM2/runtime adapter layer becomes too thin to be useful

Mitigation:
- shape stable operator-facing statuses in the adapter/domain boundary
- keep shell responses out of client-visible payloads

## Validation Architecture

### Test strategy

- **Contract tests:** verify queue/runtime/auth DTO parsing and legacy-to-canonical field normalization
- **Domain tests:** verify pure backend functions for review state shaping and metrics formatting
- **Integration tests:** verify route handlers call adapters correctly and return stable payloads
- **Type checks:** run a focused TypeScript no-emit check on the new dashboard backend scope

### Commands

- Quick backend test run:
  - `npx vitest run tests/dashboard-backend/contracts.test.ts tests/dashboard-backend/domains.test.ts`
- Route integration run:
  - `npx vitest run tests/dashboard-backend/routes.test.ts`
- Type check:
  - `npx tsc --noEmit -p dashboard/tsconfig.json`
- Full suite:
  - `npm test`

### Coverage intent

- `01-01` must establish the backend skeleton and a dedicated TS/test boundary
- `01-02` must verify typed contract normalization and functional domain logic
- `01-03` must verify brownfield integration with the current runtime and route composition

## Planning Implications

- Use two independent wave-1 plans:
  - backend/app scaffolding and brownfield integration surface
  - contracts/domain modeling and normalization layer
- Use a wave-2 integration plan:
  - route composition, adapter wiring, and integration tests

## Recommendation

Phase 1 should produce a working backend foundation with real typed routes and tests, but it should stop short of frontend implementation. That leaves Phase 2 free to move quickly on the React shell without renegotiating backend boundaries.
