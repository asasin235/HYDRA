---
phase: 1
slug: functional-backend-foundation
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-20
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.js` |
| **Quick run command** | `npx vitest run tests/dashboard-backend/contracts.test.ts tests/dashboard-backend/domains.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/dashboard-backend/contracts.test.ts tests/dashboard-backend/domains.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | MIG-01 | integration | `npx vitest run tests/dashboard-backend/bootstrap.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | MIG-01 | typecheck | `npx tsc --noEmit -p dashboard/tsconfig.json` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | ARCH-02 | contract | `npx vitest run tests/dashboard-backend/contracts.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | ARCH-03 | unit | `npx vitest run tests/dashboard-backend/domains.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | ARCH-02 | integration | `npx vitest run tests/dashboard-backend/routes.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-02 | 03 | 2 | MIG-01 | integration | `npx vitest run tests/dashboard-backend/runtime-adapters.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `dashboard/tsconfig.json` — focused TypeScript config for new dashboard scope
- [ ] `tests/dashboard-backend/bootstrap.test.ts` — backend bootstrap coverage
- [ ] `tests/dashboard-backend/contracts.test.ts` — DTO normalization coverage
- [ ] `tests/dashboard-backend/domains.test.ts` — pure backend domain coverage
- [ ] `tests/dashboard-backend/routes.test.ts` — route integration coverage
- [ ] `tests/dashboard-backend/runtime-adapters.test.ts` — PM2/runtime adapter coverage

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Backend routes reflect real operator semantics | MIG-01 | Human judgment needed to confirm brownfield compatibility of the contract surface | Inspect route responses for review/runtime resources and confirm they match dashboard operator expectations |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
