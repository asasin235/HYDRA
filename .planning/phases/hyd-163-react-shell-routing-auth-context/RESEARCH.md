# HYD-163 Research — React Shell, Routing, And Auth Context

## Issue

Start the React dashboard rewrite after HYD-141 by introducing the frontend shell, routing, and auth/session context wired to the existing backend contracts.

## Existing code structure

- `dashboard/backend/`
  - Contains the new backend foundation already built in HYD-141:
    - adapters
    - route registration
    - contract parsers / DTOs
    - normalization helpers
  - `dashboard/backend/contracts/review.ts`
    - defines the review queue/detail DTO shape used by the backend
  - `dashboard/backend/contracts/runtime.ts`
    - defines runtime overview/control DTOs
  - `dashboard/backend/adapters/session.ts`
    - exposes cookie/header session behavior
  - `dashboard/backend/server.ts`
    - creates the backend Express app and registers `/api/dashboard/backend/*` routes
- `dashboard/tsconfig.json`
  - currently includes only backend TS files and backend tests
  - no frontend TS/TSX paths are configured
- `scripts/dashboard.js`
  - current dashboard implementation is still a large server-rendered Express page
  - no React frontend exists yet in the tracked branch

## Relevant file paths

- `dashboard/backend/contracts/review.ts`
- `dashboard/backend/contracts/runtime.ts`
- `dashboard/backend/adapters/session.ts`
- `dashboard/backend/server.ts`
- `dashboard/tsconfig.json`
- `scripts/dashboard.js`
- `package.json`

## Dependencies

- Existing backend contracts in `dashboard/backend/contracts/`
- Existing backend bootstrap and session behavior in `dashboard/backend/server.ts` and `adapters/session.ts`
- New frontend build/runtime dependencies, because the repo currently has no React or router packages installed

## Constraints

- There is no existing frontend scaffold:
  - no `dashboard/frontend/` directory
  - no React app entry
  - no React/Vite dependencies in `package.json`
- The current dashboard is still served from `scripts/dashboard.js`, so Phase 2 should coexist with that implementation rather than trying to replace the full legacy UI in one step.
- The issue specifically says to consume `dashboard/backend/contracts/` instead of redefining client-side API shapes.
- Auth/session context should align with:
  - cookie name from the backend bootstrap payload
  - machine auth header behavior from the backend session adapter

## Risks

- Tooling setup:
  - Phase 2 likely requires adding the first React toolchain and frontend TS/TSX config in the repo.
- Contract reuse:
  - the backend contracts are TypeScript modules, so the frontend shell should import and use them directly rather than duplicating DTO definitions.
- Scope creep:
  - once routing exists, it will be tempting to pull review queue/detail UI into this phase; that should stay deferred to Phase 3.

## Research conclusion

HYD-163 is a true bootstrap phase. The minimal valid implementation is:

1. create the first `dashboard/frontend/` React app shell
2. add routing/layout placeholders for the dashboard sections
3. add an auth/session/bootstrap context that reads from the backend bootstrap/session contract
4. update dashboard TS config and package dependencies to support TSX/React
5. keep the UI route surface intentionally shallow so Phase 3–5 can land on top of the shell
