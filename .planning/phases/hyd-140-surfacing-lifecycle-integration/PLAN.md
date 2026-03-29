# HYD-140 Plan — Add Integration Test for Full Surfacing Lifecycle

## Goal

Add an end-to-end integration scenario that proves proactive memory surfacing is computed and refreshed through the review lifecycle, while introducing only the minimum production seam required to support that test.

## Files to modify

- `tests/review-pipeline.integration.test.js`
- `core/review-queue-db.js`
- `scripts/dashboard-participant-tagging.js`

## Files to create

- `core/review-context-surfacing.js`

## Files that may need small supporting changes

- `core/review-actions.js`
- `core/memory-facts-db.js`
- `core/interaction-participants-db.js`

## Implementation steps

1. Add a small `review-context-surfacing` module that gathers participant-linked context for a review item and returns a stable payload shape with:
   - `participants`
   - `last_interaction`
   - `open_items`
   - `key_facts`
   - scored entries sorted by relevance
2. Persist that payload on `audio_review_queue` using the existing queue row instead of adding a parallel store, favoring `metadata_json` unless a dedicated column is clearly cleaner during implementation.
3. Hook surfacing recomputation into review-queue creation so a newly ingested item gets a surfaced payload immediately.
4. Hook the same recompute function into participant-tagging writes so adding or linking a participant refreshes the stored payload instead of introducing a second implementation path.
5. Extend `tests/review-pipeline.integration.test.js` to seed people, interactions, facts, and tasks, then assert:
   - queue-item creation stores surfaced context
   - required sections are present
   - entries are relevance-scored and sorted
   - re-tagging refreshes the surfaced payload with newly linked participant data
6. Keep failure handling soft: if one resolver path fails, log it and keep the queue item writable with an empty or partial surfaced payload instead of breaking review creation.

## Test strategy

- Run `npx vitest run tests/review-pipeline.integration.test.js` after each surfacing hook lands.
- Re-run `npx vitest run tests/core/context-resolvers.test.js tests/review-pipeline.integration.test.js` before the issue commit.
- Run full `npm test` at Gate 6 and compare against the known baseline dashboard-backend failures.
- Run `npx tsc --noEmit` only if TypeScript files are changed.
