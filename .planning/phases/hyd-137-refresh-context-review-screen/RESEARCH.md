# HYD-137 Research — Refresh Context Action On Review Screen

## Issue

Add a `Refresh Context` action to the review screen so the Prior Context panel can be re-run against the current participant set, with loading feedback and automatic refresh after participant tagging.

## Existing code structure

- `scripts/dashboard-review-detail.js`
  - Owns the review-detail HTML route and currently renders:
    - normalized summary
    - raw transcript
    - classification
    - a simple participant list
    - review action buttons
  - It does **not** currently render:
    - a Prior Context panel
    - a refresh action
    - the participant-tagging widget from `dashboard-participant-tagging.js`
- `scripts/dashboard-participant-tagging.js`
  - Owns the participant-tagging API and the embeddable participant-tagging widget HTML/JS.
  - Review-stage tagging now persists through `participant_labels_json` on the queue item and triggers surfacing refresh on write.
  - The widget currently reloads the whole page after add/link/remove actions instead of updating adjacent UI in place.
- `core/review-context-surfacing.js`
  - Computes and persists `surfaced_context` onto the queue item metadata.
  - Queue creation and participant-tagging writes already flow through this refresh seam.
- `core/review-queue-db.js`
  - Exposes `getQueueItem()` and now surfaces `item.surfaced_context` from metadata.

## Relevant file paths

- `scripts/dashboard-review-detail.js`
- `scripts/dashboard-participant-tagging.js`
- `core/review-context-surfacing.js`
- `core/review-queue-db.js`
- `tests/review-pipeline.integration.test.js`

## Dependencies

- Review detail HTML route in `dashboard-review-detail.js`
- Participant-tagging widget and APIs in `dashboard-participant-tagging.js`
- Surfacing refresh seam in `review-context-surfacing.js`
- Queue item metadata persistence in `review-queue-db.js`

## Constraints

- There is no existing Prior Context panel in the tracked review-detail page; this issue must introduce one.
- The current participant list in the review-detail page is still derived from `interaction_participants`, which is the final approved interaction table, not the review-stage `participant_labels_json` source now used for pre-approval tagging.
- The participant-tagging widget exists but is not currently embedded into the review detail page.
- The refresh path should reuse the existing queue surfacing seam instead of rebuilding context in the UI layer.

## Risks

- Server/client split:
  - The review page is rendered as one server-side HTML response, so achieving loading + live replacement likely requires a small client-side fetch endpoint for refreshed context.
- UI consistency:
  - If the participant list and Prior Context panel read from different participant sources, the page will still drift after tagging.
- Hidden compatibility issues:
  - `dashboard-review-detail.js` currently parses `item.metadata` even though `getQueueItem()` already returns parsed metadata and surfaced context helpers.

## Research conclusion

HYD-137 requires a small review-detail UI pass rather than a button-only patch. The minimal viable implementation is:

1. render a Prior Context panel from `item.surfaced_context`
2. embed the participant-tagging widget on the same page
3. add a dedicated refresh endpoint that reuses `refreshReviewQueueSurfacing()`
4. update the page JS so both the new button and participant-tagging actions refresh the panel content in place with a loading state
5. switch the review-detail participant list to the review-stage participant labels so the page reflects the same source of truth as surfacing
