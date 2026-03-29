# HYD-139 Plan — Add Proactive Context Summary To iOS Shortcut Notifications

## Goal

Send a compact one-line notification after review queue item creation using the persisted surfaced context, while degrading cleanly to generic text when no participant history is available.

## Files to modify

- `scripts/ingest-audio.js`

## Files to create

- `core/review-notifications.js`
- `tests/core/review-notifications.test.js`

## Files that may need small supporting changes

- `core/review-queue-db.js`
- `core/review-context-surfacing.js`

## Implementation steps

1. Create a review notification module that:
   - formats a one-line iOS Shortcut summary from `item.surfaced_context`
   - falls back to generic text when participants or history are missing
   - sends the payload only when a webhook env var is configured
2. Keep the transport minimal and conservative by POSTing a small JSON body containing the formatted message and queue metadata.
3. Hook notification dispatch into `scripts/ingest-audio.js` after `enqueueForReview(...)` so the queue item already has persisted surfaced context when the message is composed.
4. Ensure notification failures are non-fatal and only log warnings so ingest still completes.
5. Add focused tests for:
   - resolved participant + last-contact summary + open-task count formatting
   - generic fallback formatting
   - no-op behavior when the webhook URL is missing

## Test strategy

- Run `npx vitest run tests/core/review-notifications.test.js` during implementation.
- Re-run `npx vitest run tests/review-pipeline.integration.test.js tests/core/review-notifications.test.js` before Gate 6.
- Run full `npm test` at Gate 6 and compare against the known dashboard-backend baseline failures.
