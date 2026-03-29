# HYD-138 Plan — Add Unit Tests for Each Context Resolver

## Goal

Add deterministic unit coverage for five concrete resolver entry points:

1. `resolveDomain()`
2. `resolveRelationship()`
3. `resolveHeuristics()`
4. `getParticipantPriors()`
5. `applyPriors()`

## Files to modify

- `tests/core/context-resolvers.test.js`

## Files that may be modified only if tests expose a bug

- `core/interaction-priors.js`
- `core/heuristic-resolver.js`

## Implementation steps

1. Add a focused resolver test file instead of overloading unrelated suites.
2. Cover the four required scenario classes across all five targets:
   - rich history
   - no history
   - restricted interactions
   - unresolved participants
3. Use temp `BRAIN_PATH` fixtures for DB-backed prior-history tests.
4. If tests expose schema or filtering bugs in `interaction-priors`, make the minimal fix there.
5. Run targeted Vitest during development, then broader verification later.

## Test strategy

- Run `npx vitest run tests/core/context-resolvers.test.js` during implementation.
- Assert exact null/empty behavior.
- Assert unresolved participants do not crash resolver code.
- Assert restricted interactions do not influence surfaced prior results.
