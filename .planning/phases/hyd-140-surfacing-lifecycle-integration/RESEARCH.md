# HYD-140 Research — Full Surfacing Lifecycle Integration Test

## Issue

Add an integration test for the full proactive memory surfacing lifecycle.

## Existing code structure

- `core/review-queue-db.js`
  - Owns review queue persistence.
  - Current tracked schema includes queue metadata, participant labels, suggested tasks/facts, and review state fields.
  - No existing `surfaced_context` column or explicit surfacing payload field is present in the tracked schema.
- `core/review-actions.js`
  - Handles draft save, approve, archive, and re-run classification transitions.
  - No surfacing orchestration hook exists here yet.
- `scripts/dashboard-participant-tagging.js`
  - Adds, updates, and removes participants tied to a review item.
  - This is the clearest existing re-tagging path for the “context refreshed after new participant tag” requirement.
- `core/memory-facts-db.js`
  - Stores durable facts and extracted tasks.
  - Provides existing data sources for `key_facts` and `open_items`-style surfaced context.
- `core/interaction-participants-db.js`
  - Links people to interactions and provides the participant relationship layer needed for per-person context lookup.
- `core/retrieval-filters.js`
  - Encodes restricted-content exclusion rules for interaction retrieval.
- `tests/review-pipeline.integration.test.js`
  - Existing integration suite around the review lifecycle.
  - Best current place to extend for a new end-to-end surfacing scenario.

## Relevant file paths

- `core/review-queue-db.js`
- `core/review-actions.js`
- `core/interaction-participants-db.js`
- `core/memory-facts-db.js`
- `core/retrieval-filters.js`
- `scripts/dashboard-participant-tagging.js`
- `tests/review-pipeline.integration.test.js`

## Dependencies

- SQLite-backed review queue, interactions, participants, people, facts, and tasks tables
- Review queue mutation helpers for item creation/update
- Participant tagging APIs/helpers for refresh triggers
- Existing restricted-content filtering expectations from retrieval-related code

## Constraints

- The current tracked branch does **not** expose:
  - a dedicated surfacing orchestrator module
  - a persisted `surfaced_context` field on review queue items
  - any direct hook that recomputes context when participants are re-tagged
- This means HYD-140 is not only missing an integration test; the branch is also missing the core seam the test is meant to exercise.
- Because HYD-137 and HYD-139 depend on surfacing output later in the epic, HYD-140 likely needs to establish a minimal surfacing foundation rather than only add assertions to existing code.

## Risks

- Scope mismatch:
  - The issue title says “add integration test,” but the tracked codebase lacks the surfacing lifecycle that the test is supposed to validate.
- Persistence decision:
  - Need to decide whether surfaced context should live in:
    - a dedicated queue table column, or
    - existing JSON metadata on the queue item.
- Refresh trigger ambiguity:
  - Re-tag refresh could be triggered from:
    - participant tagging routes,
    - review queue update helpers,
    - or a new explicit recompute function invoked by both tests and UI.
- Data-shape ambiguity:
  - Acceptance criteria mention `last_interaction`, `open_items`, `key_facts`, and relevance scores, but no canonical structure exists in the tracked branch yet.

## Research conclusion

HYD-140 requires more than a test-only change on the current tracked branch. The clean implementation seam is to introduce a minimal surfacing module plus queue persistence hook, then extend `tests/review-pipeline.integration.test.js` to validate:

1. surfacing computation on queue item creation
2. persisted surfaced context payload shape
3. refresh on participant re-tag
4. safe degradation when one resolver fails

That keeps the change aligned with the issue while also creating the shared surfacing output that HYD-137 and HYD-139 will need later in Epic 1.
