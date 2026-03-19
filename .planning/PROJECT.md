# HYDRA

## What This Is

HYDRA is a self-hosted personal AI operating system that runs a fleet of specialized agents on a single Mac Mini and coordinates them through Slack, PM2, SQLite, LanceDB, and Redis. The current brownfield codebase already operates real ingestion, memory, automation, and agent workflows; the active product push is to modernize the operator dashboard into a React + TypeScript frontend backed by a Node.js API without destabilizing the rest of the runtime.

## Core Value

HYDRA must reliably turn personal and work context into low-overhead, human-supervised action through one local system.

## Requirements

### Validated

- ✓ Audio recordings can be ingested, transcribed, and persisted into HYDRA context and memory flows — existing brownfield capability
- ✓ Specialized agents can be invoked through the Slack gateway and run against shared runtime/storage infrastructure — existing brownfield capability
- ✓ Shared structured and vector memory exists through SQLite, LanceDB, and supporting ingestion pipelines — existing brownfield capability
- ✓ PM2-managed multi-process operations, health surfaces, and budget enforcement already exist in production on the Mac Mini host — existing brownfield capability
- ✓ A browser-accessible dashboard exists today for operator workflows, which proves the need for a browser operator surface even though the implementation is monolithic — existing brownfield capability
- ✓ Reviewed-memory tables, transcript storage, and queue-oriented workflows exist in the codebase, but their contracts and UI behavior still drift — existing brownfield capability

### Active

- [ ] Rewrite the dashboard frontend as a dedicated React + TypeScript application instead of inline HTML generated inside `scripts/dashboard.js`
- [ ] Expose typed Node.js backend APIs for dashboard operator workflows instead of relying on route-specific HTML and schema drift
- [ ] Implement the new dashboard/backend in a functional style with pure domain modules and thin IO adapters
- [ ] Give operators a stable authenticated dashboard shell with navigation for review queue, runtime operations, and metrics
- [ ] Make the review queue browsable with filters, counts, and normalized lifecycle states
- [ ] Make each review item viewable with transcript, summary, classification, participant, and audit context
- [ ] Allow safe draft-saving of review edits without triggering ingest
- [ ] Allow safe approval and archive/disapprove actions with correct ingest behavior and audit preservation
- [ ] Ensure active audio ingest paths land new items in `needs_review` and make them visible in the dashboard without manual DB repair
- [ ] Surface PM2 health, process controls, spend, and queue metrics in the new operator UI
- [ ] Add automated test coverage around dashboard API and review-queue flows that are currently vulnerable to naming drift

### Out of Scope

- Replacing Slack as HYDRA’s primary conversational interface — Slack remains the primary user-facing command surface
- Rewriting all agents and core modules into TypeScript during the dashboard migration — too broad for the current milestone
- Moving HYDRA to cloud orchestration, Kubernetes, or a multi-host architecture — conflicts with the single-host design principle
- Rebuilding every legacy dashboard feature at once — operator-critical review/runtime flows come first

## Context

HYDRA is a brownfield Node.js 22 ESM monorepo running on a Mac Mini with PM2. The current architecture is Slack-first, but Notion documentation and the existing Express dashboard both show a real operator need for a browser surface. Notion pages describe the original HYDRA objective as autonomous life-management through specialized agents, and recent dev logs specifically call out reviewed-memory naming drift and the need for stronger dashboard/API coverage. The codebase map confirms a monolithic `scripts/dashboard.js`, shared SQLite/LanceDB state, PM2-managed processes, and a review-queue workflow that is already partially implemented. The dashboard rewrite should therefore be treated as a strangler migration: replace the operator surface and API contracts without re-platforming the rest of HYDRA.

## Constraints

- **Tech stack**: Node.js 22 ESM remains the runtime baseline — the existing host, process model, and modules already depend on it
- **Host model**: Single Mac Mini + PM2 remains the deployment shape — HYDRA explicitly optimizes for single-host simplicity
- **Storage**: SQLite, LanceDB, Redis, and filesystem paths under `BRAIN_PATH` remain the system of record — dashboard work must integrate with existing stores
- **UI compatibility**: Slack-based approvals and browser-based operator flows must coexist — the dashboard cannot assume it replaces Slack workflows wholesale
- **Operational safety**: Human review and approval behavior for audio/reviewed-memory flows must remain correct during migration — broken approvals are product regressions
- **Implementation style**: New dashboard/frontend/backend work should prefer functional modules and explicit data contracts over class-heavy abstractions — this is a user preference and a maintainability goal

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat HYDRA as a brownfield project, not a greenfield rewrite | The repo, runtime, and Notion docs all describe an already running system with validated infrastructure | — Pending |
| Focus the first active roadmap on dashboard modernization rather than whole-system redesign | The user’s immediate goal is a React + TypeScript dashboard rewrite with Node backend support | — Pending |
| Preserve Node.js/PM2/SQLite/LanceDB as core infrastructure during the dashboard rewrite | Re-platforming the runtime at the same time would add unnecessary risk and scope | — Pending |
| Use a functional architecture for the new dashboard/backend modules | The user explicitly requested a functional programming style | — Pending |
| Keep Slack as the primary interaction channel while the browser dashboard becomes the operator cockpit | HYDRA’s documented design principle is Slack-first, but browser ops are still needed for review and observability | — Pending |

---
*Last updated: 2026-03-20 after initialization*
