# HYD-138 Research — Context Resolver Unit Tests

## Issue

Add unit tests for each context resolver.

## Existing code structure

- `core/heuristic-resolver.js`
  - Exposes three resolver-style entry points:
    - `resolveDomain(text)`
    - `resolveRelationship(text, participantContext)`
    - `resolveHeuristics(text, participantContext)`
- `core/interaction-priors.js`
  - Exposes prior/history resolution helpers:
    - `getParticipantPriors(personId)`
    - `applyPriors(heuristicResult, personId)`
    - `getBatchPriors(personIds)`
- `core/interaction-classifier.js`
  - Depends on resolver outputs indirectly through classification behavior.
- Existing tests do not yet cover the required four-scenario matrix across five resolver targets.

## Relevant file paths

- `core/heuristic-resolver.js`
- `core/interaction-priors.js`
- `core/interaction-classifier.js`
- `tests/core/interaction-classifier.test.js`

## Dependencies

- `core/heuristic-resolver.js`
  - Pure logic except logger usage.
- `core/interaction-priors.js`
  - Depends on `getDb()` from `core/db.js`
  - Queries `interactions` and `interaction_participants`
  - Needs DB-backed fixtures for realistic prior/history cases.

## Constraints

- Scope is resolver tests plus any minimal fix exposed by those tests.
- The issue says there are 5 resolvers, but the current tracked codebase does not expose a neat `context-resolvers/` suite.
- The cleanest five current targets are:
  - `resolveDomain`
  - `resolveRelationship`
  - `resolveHeuristics`
  - `getParticipantPriors`
  - `applyPriors`

## Risks

- The current `interaction-priors` implementation may not line up cleanly with the tracked `interactions` schema.
- Restricted-interaction handling is not obviously enforced inside priors today.
- Null/empty behavior differs across the surface:
  - heuristic resolver returns `unknown`
  - priors resolver returns `null`

## Research conclusion

Execution should add focused resolver tests against those five entry points and keep any production changes minimal, test-driven, and limited to the resolver surface.
