# HYD-137 Plan — Add Refresh Context Action On Review Screen

## Goal

Render a Prior Context panel on the review detail page, add a `Refresh Context` action that reuses the existing surfacing seam, and keep the panel in sync when review-stage participant tags change.

## Files to modify

- `scripts/dashboard-review-detail.js`
- `scripts/dashboard-participant-tagging.js`

## Files that may need small supporting changes

- `core/review-context-surfacing.js`
- `core/review-queue-db.js`
- `tests/review-pipeline.integration.test.js`

## Files to create if view logic needs isolated coverage

- `tests/dashboard-review-detail.test.js`

## Implementation steps

1. Update the review-detail route to read review-stage participant labels and the persisted `surfaced_context` snapshot from the queue item instead of relying on approved interaction participants.
2. Add a Prior Context panel renderer that shows:
   - header with `Refresh Context` button
   - current participants
   - last interaction
   - open items
   - key facts
3. Embed the participant-tagging widget into the review detail page so tags can be changed in the same screen the context is refreshed from.
4. Add a dedicated review-detail API endpoint that calls the existing surfacing refresh seam and returns the updated queue item / surfaced payload.
5. Add client-side page logic for:
   - button loading state while refresh is in flight
   - replacing panel content with the new payload on success
   - reusing the same panel-refresh function after participant add/link/remove completes
6. Keep the implementation narrow by reusing the current queue persistence and surfacing modules rather than introducing a second context assembly path in the UI layer.

## Test strategy

- Add or extend targeted tests for review-detail rendering/helpers if the route logic is factored into testable functions.
- Re-run `npx vitest run tests/review-pipeline.integration.test.js` to ensure surfacing behavior stays intact.
- Run any new dashboard review-detail test file directly if added.
- Run full `npm test` at Gate 6 and compare against the known dashboard-backend baseline failures.
