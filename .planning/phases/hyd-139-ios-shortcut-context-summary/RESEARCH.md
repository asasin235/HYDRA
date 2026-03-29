# HYD-139 Research — Proactive Context Summary For iOS Shortcut Notifications

## Issue

When a new review queue item is created, send an iOS Shortcut-friendly notification line that summarizes the newly surfaced context.

## Existing code structure

- `scripts/ingest-audio.js`
  - Main creation path for new review queue items in this tracked branch.
  - Flow:
    1. transcribe / summarize
    2. `enqueueForReview(...)`
    3. store transcript + normalized summary
    4. move files to processed
  - This is the best available hook for sending a notification after queue creation.
- `core/review-queue-db.js`
  - Queue creation now triggers surfacing refresh as part of `saveToReviewQueue()`.
  - `getQueueItem()` exposes `surfaced_context` from queue metadata.
- `core/review-context-surfacing.js`
  - Computes the payload we need for notification text:
    - participants
    - last interaction
    - open items
    - key facts
- `scripts/plaud-sync.js` / `scripts/plaud-sync-new.js`
  - Acquire files and hand them to the ingest path or local inbox.
  - Do not contain the actual review queue creation logic.

## Relevant file paths

- `scripts/ingest-audio.js`
- `core/review-queue-db.js`
- `core/review-context-surfacing.js`
- `tests/review-pipeline.integration.test.js`

## Dependencies

- Review queue creation in `ingest-audio.js`
- Surfaced context persisted on the queue item
- A notifier transport for the iOS Shortcut system

## Constraints

- I could not find an existing in-repo implementation of the “iOS Shortcut notification system”:
  - no current `shortcut`/`ios`/`pushcut`/`gotify`/`pushover` notifier code
  - no existing env var in `sample.env` that clearly points to an iOS Shortcut webhook
- The current ingest path does not resolve participants itself; in many cases the surfaced payload at creation time will still fall back to generic text unless participant labels are already present.
- Because there is no existing transport implementation in the repo, this issue needs a minimal new notifier hook rather than only a formatter tweak.

## Risks

- Transport ambiguity:
  - Without an existing notifier contract, the safest implementation is a small webhook sender with a conservative JSON payload.
- Data sparsity:
  - Surfaced context may not include a resolved person at creation time, so the generic fallback path must be first-class and tested.
- Sequencing:
  - Notification must read the queue item after surfacing has been persisted, not before.

## Research conclusion

HYD-139 cannot be completed by patching an existing notifier in this branch because no such notifier is present. The clean minimal implementation is:

1. add a dedicated notification formatter around `item.surfaced_context`
2. add a small webhook-based sender that is enabled only when an iOS Shortcut URL env var is configured
3. call that sender from `scripts/ingest-audio.js` after queue creation
4. test the formatter for:
   - resolved participant + last contact + task count
   - generic fallback when context is sparse
