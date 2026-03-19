# Stack Research

**Domain:** brownfield operator dashboard for a self-hosted multi-agent Node.js system
**Researched:** 2026-03-20
**Confidence:** MEDIUM

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22.x | Runtime for dashboard backend and existing HYDRA services | Already required by the brownfield system and matches PM2/ESM/runtime assumptions |
| TypeScript | 5.x | Static typing for new dashboard frontend/backend modules | Adds contract safety around API and reviewed-memory flows that currently drift |
| React | 19.x | Dashboard frontend UI | Fits the user request, supports componentized operator UX, and modernizes away from server-generated inline HTML |
| Vite | 6.x/7.x | Frontend dev/build tool | Fast local iteration for a dashboard app and simple static build output for PM2/Node hosting |
| Express or Fastify-compatible Node HTTP layer | Current repo uses Express 4.x | Backend API surface for dashboard contracts | Brownfield integration is easiest if the new backend reuses the existing Node process model and shared runtime helpers |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| React Router | 7.x | Dashboard route composition | Use for review queue, runtime, and metrics navigation in the React app |
| TanStack Query | 5.x | Server-state fetching and cache invalidation | Use for review queue lists, detail pages, metrics, and process-control mutations |
| Zod | 3.x/4.x | Runtime schema validation | Use at the backend boundary and frontend client boundary to normalize queue/API contracts |
| better-sqlite3 | 11.7.x | Existing SQLite integration | Keep as the existing data access layer for brownfield dashboard APIs |
| ws or Server-Sent Events | existing `ws` in repo | Incremental live updates | Use only where logs/process state truly need streaming; polling is acceptable elsewhere |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Vitest | Unit/integration tests | Already present in the repo; extend it to cover dashboard contracts and reviewed-memory flows |
| ESLint | Linting | Keep the existing lint path and extend rules for TypeScript files |
| PM2 | Process supervision | Continue to run the dashboard service and related workers through the current ecosystem |

## Installation

```bash
# Frontend core
npm install react react-dom react-router-dom @tanstack/react-query zod

# Backend / typing
npm install typescript

# Dev dependencies
npm install -D vite @vitejs/plugin-react
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| React + Vite | Next.js | Use only if dashboard SEO/SSR or edge deployment becomes a real requirement, which it is not today |
| Node API on current Express-compatible runtime | Full frontend-only app calling ad hoc routes | Avoid for this brownfield case because contract normalization belongs on the backend |
| Functional domain modules + adapter functions | Class-heavy service/controller hierarchy | Only use classes where third-party libraries force them; functions are simpler for this migration |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Rewriting the entire HYDRA runtime to TypeScript first | Delays the operator dashboard objective and multiplies migration risk | Add typed modules around the new dashboard/backend boundary first |
| Pushing UI logic back into server-generated HTML strings | Keeps the current monolith problem and makes the rewrite pointless | Use React components with typed API data |
| Introducing microservices for the dashboard rewrite | Adds operational complexity that contradicts HYDRA’s single-host principle | Keep a Node backend integrated with the existing runtime and PM2 |

## Stack Patterns by Variant

**If the dashboard stays inside the current Node service initially:**
- Use a React SPA served by the Node backend
- Because it minimizes deployment complexity and fits the current PM2 model

**If the dashboard splits into its own PM2 app later:**
- Keep the API adapters in shared Node modules and deploy the frontend separately
- Because it preserves the contracts while allowing cleaner ownership boundaries

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Node 22.x | ESM + current PM2 setup | Matches the current repo and host assumptions |
| React 19.x | Vite modern frontend toolchain | Good fit for a browser-only operator app |
| TypeScript 5.x | Vitest + ESLint modern configs | Needed for typed frontend/backend contracts |

## Sources

- Local repo `package.json` — verified current runtime, deps, and operational tooling
- [.planning/codebase/STACK.md](/Users/hydra/Desktop/projects/HYDRA/.planning/codebase/STACK.md) — verified existing brownfield stack assumptions
- [🐉 HYDRA — Architecture & Objectives](https://www.notion.so/315b31d7af7a81c08d3ac03876782fed) — verified single-host and Slack-first design principles
- [🐉 HYDRA OS](https://www.notion.so/31db31d7af7a815fa1aecd5d6fda9e96) — verified workspace/runtime structure

---
*Stack research for: brownfield operator dashboard for a self-hosted multi-agent Node.js system*
*Researched: 2026-03-20*
