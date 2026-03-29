# HYD-163 Plan — React Shell, Routing, And Auth Context

## Goal

Bootstrap the first React dashboard frontend on top of the new backend foundation, with a minimal routed shell and an auth/session context that reuses the existing backend bootstrap/session contract.

## Files to modify

- `package.json`
- `package-lock.json`
- `dashboard/tsconfig.json`

## Files to create

- `dashboard/frontend/index.html`
- `dashboard/frontend/src/main.tsx`
- `dashboard/frontend/src/app/App.tsx`
- `dashboard/frontend/src/app/routes.tsx`
- `dashboard/frontend/src/app/layout/AppShell.tsx`
- `dashboard/frontend/src/auth/AuthProvider.tsx`
- `dashboard/frontend/src/auth/auth-client.ts`
- `dashboard/frontend/src/styles.css`
- `dashboard/vite.config.ts`
- `tests/dashboard-frontend/*.test.tsx` or equivalent focused frontend bootstrap tests

## Implementation steps

1. Add the minimal frontend toolchain needed for a React/TS shell:
   - React / React DOM
   - React Router
   - Vite + TS React plugin
   - any minimal frontend test support needed for shell verification
2. Create `dashboard/frontend/` with a small routed app shell and placeholder routes for the future review/runtime screens.
3. Build an auth/session bootstrap client that calls `/api/dashboard/backend/bootstrap` and exposes:
   - loading / ready state
   - backend host/port metadata
   - cookie/header session naming for later authenticated calls
4. Keep contract reuse explicit by importing backend contract modules where the shell touches review/runtime DTO parsing or bootstrap response handling, rather than duplicating client-side shapes.
5. Add a clean shell layout with navigation placeholders for:
   - Home / Overview
   - Review
   - Runtime
6. Wire the frontend build config so the React shell can be typechecked and rendered independently without replacing the legacy `scripts/dashboard.js` runtime in this phase.

## Test strategy

- Add focused frontend shell/bootstrap tests for auth provider and routed rendering if the chosen test setup supports it.
- Run targeted frontend verification first (`vitest` and/or `tsc --noEmit` scoped to dashboard/frontend).
- Run `npx tsc --noEmit --project dashboard/tsconfig.json` after frontend TS/TSX is added.
- Run full `npm test` at Gate 6 and compare against the known baseline dashboard-backend failures.
