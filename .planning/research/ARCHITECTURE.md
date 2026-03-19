# Architecture Research

**Domain:** brownfield React dashboard + Node API for HYDRA operations
**Researched:** 2026-03-20
**Confidence:** MEDIUM

## Standard Architecture

### System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    React Operator Frontend                 │
├─────────────────────────────────────────────────────────────┤
│  Review Queue UI   Runtime UI   Metrics UI   Shared Shell  │
├─────────────────────────────────────────────────────────────┤
│                     Node API Backend                       │
├─────────────────────────────────────────────────────────────┤
│  Review API    Runtime API    Metrics API   Auth API       │
├─────────────────────────────────────────────────────────────┤
│                    Domain / Adapter Layer                  │
├─────────────────────────────────────────────────────────────┤
│  Queue Domain   PM2 Adapter   Metrics Adapter   Audit Flow │
├─────────────────────────────────────────────────────────────┤
│                  Existing HYDRA Runtime/Data               │
│  SQLite   LanceDB   PM2   Filesystem/BRAIN_PATH   Redis    │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| React app shell | Navigation, route composition, shared layout, auth-aware UX | React + Router + server-state data hooks |
| Review API | Normalize queue/detail/action contracts | Small request handlers calling pure domain functions |
| Runtime API | Health, process controls, metrics, logs | Thin Node handlers wrapping PM2 and metrics adapters |
| Domain modules | State transitions, normalization, contract shaping | Pure functions with explicit inputs/outputs |
| IO adapters | SQLite, PM2, filesystem, existing HYDRA modules | Side-effecting functions isolated at the edge |

## Recommended Project Structure

```text
dashboard/
├── frontend/                 # React + TypeScript app
│   ├── app/                  # routes, layout, providers
│   ├── features/             # review, runtime, metrics screens
│   ├── components/           # reusable UI pieces
│   ├── lib/                  # typed API client, utilities
│   └── styles/               # global/theme styles
├── backend/                  # Node API layer
│   ├── routes/               # HTTP route definitions
│   ├── domains/              # pure review/runtime/metrics logic
│   ├── adapters/             # PM2/db/filesystem integrations
│   └── contracts/            # Zod schemas and DTO types
└── shared/                   # shared types and helpers
```

### Structure Rationale

- **frontend/** isolates browser concerns from Node runtime concerns.
- **backend/domains/** keeps functional business logic separate from Express/Fastify adapters.
- **contracts/** makes the new UI/API boundary explicit so brownfield schema drift is contained in one layer.

## Architectural Patterns

### Pattern 1: Functional Core, Imperative Shell

**What:** Keep domain logic pure and isolate side effects in adapters.
**When to use:** Review-state transitions, queue normalization, metrics aggregation.
**Trade-offs:** Easier testing and reasoning, but requires discipline at module boundaries.

**Example:**
```typescript
type ReviewState = 'needs_review' | 'reviewed' | 'approved' | 'archived';

export const transitionReview = (current: ReviewState, next: ReviewState): ReviewState => {
  if (current === 'approved' && next === 'archived') throw new Error('illegal transition');
  return next;
};
```

### Pattern 2: Contract-First API Modules

**What:** Define request/response schemas before wiring handlers.
**When to use:** Queue list/detail endpoints, approval/archive actions, PM2 control mutations.
**Trade-offs:** Slightly more upfront work, but sharply reduces frontend/backend drift.

**Example:**
```typescript
export const ReviewItemDto = z.object({
  id: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  language: z.string(),
});
```

### Pattern 3: Strangler Migration

**What:** Replace legacy dashboard surfaces incrementally while keeping current runtime intact.
**When to use:** Brownfield migrations where the existing Express dashboard already serves live workflows.
**Trade-offs:** Temporary duplication exists, but risk is far lower than a flag day rewrite.

## Data Flow

### Request Flow

```text
[Operator Click]
    ↓
[React Route] → [typed API client] → [Node route] → [domain function]
    ↓                                                    ↓
[UI update] ← [DTO parse] ← [response mapper] ← [adapter / store]
```

### State Management

```text
[Server state]
    ↓
[React query cache] ←→ [mutations] → [Node API]
    ↓
[Route components]
```

### Key Data Flows

1. **Review queue read flow:** frontend list/detail route → typed API → queue normalization layer → SQLite/transcript/classification reads.
2. **Approval flow:** frontend mutation → Node action route → domain transition + approval pipeline → queue refresh.
3. **Runtime ops flow:** frontend control panel → backend PM2 adapter → process status response + metrics refresh.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 trusted operator | Single backend process and SPA are sufficient |
| Multiple internal operators | Add stronger session management, audit details, and mutation guards first |
| Larger than single-host HYDRA | Revisit boundaries only after the underlying runtime itself changes |

### Scaling Priorities

1. **First bottleneck:** Schema/contract drift between queue tables and UI payloads — fix with a contract layer.
2. **Second bottleneck:** Monolithic dashboard route complexity — fix by splitting frontend/backend/modules.

## Anti-Patterns

### Anti-Pattern 1: UI Coupled Directly to Raw DB Rows

**What people do:** Pass SQLite row shapes straight into route responses and UI assumptions.
**Why it's wrong:** Legacy/new field names drift and break approval flows.
**Do this instead:** Normalize every reviewed-memory payload in one contract layer.

### Anti-Pattern 2: Rebuilding Runtime and Dashboard Together

**What people do:** Mix dashboard rewrite, runtime migration, and full TypeScript conversion into one milestone.
**Why it's wrong:** Too many moving parts and no safe rollback boundary.
**Do this instead:** Keep the runtime stable and replace the operator surface incrementally.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| PM2 | Backend adapter functions | Shell out only on the backend, never from the browser |
| SQLite / better-sqlite3 | Existing HYDRA DB helpers or thin dashboard-specific accessors | Reuse current storage, don’t fork data |
| LanceDB / memory subsystems | Read-only or indirect via existing modules | Not every dashboard phase needs direct vector-store access |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| frontend ↔ backend | Typed HTTP DTOs | Primary contract boundary |
| backend routes ↔ domains | Direct function calls | Keep domains pure where possible |
| backend adapters ↔ HYDRA runtime | Existing modules / controlled shell calls | Respect current brownfield boundaries |

## Sources

- [.planning/codebase/ARCHITECTURE.md](/Users/hydra/Desktop/projects/HYDRA/.planning/codebase/ARCHITECTURE.md)
- [🐉 HYDRA — Architecture & Objectives](https://www.notion.so/315b31d7af7a81c08d3ac03876782fed)
- [📓 Dev Logs](https://www.notion.so/31db31d7af7a81afbdc4e7aadcb2263c)

---
*Architecture research for: brownfield React dashboard + Node API for HYDRA operations*
*Researched: 2026-03-20*
