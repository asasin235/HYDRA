/**
 * Review Actions — orchestrates review workflow transitions.
 * Handles save draft, approve, archive, and re-run classification actions.
 * Preserves manual overrides on re-run.
 * @module core/review-actions
 */
import { getDb } from './db.js';
import { updateQueueItem, getQueueItem } from './review-queue-db.js';
import { createLogger } from './logger.js';

const log = createLogger('review-actions');

/**
 * Save draft — mark as reviewed with notes, preserving all current state.
 * Persists edits without triggering final ingest.
 */
export function saveDraft(reviewQueueId, { notes, reviewer } = {}) {
  const item = getQueueItem(reviewQueueId);
  if (!item) throw new Error(`Queue item ${reviewQueueId} not found`);

  updateQueueItem(reviewQueueId, {
    status: 'reviewed',
    review_notes: notes || item.review_notes,
    reviewed_by: reviewer || 'dashboard-user',
    reviewed_at: new Date().toISOString(),
  });

  log.info({ reviewQueueId, reviewer }, 'Draft saved');
  return { action: 'save_draft', status: 'reviewed', reviewQueueId };
}

/**
 * Approve — mark as approved, triggering downstream approval pipeline.
 * This transitions the item to 'approved' and should be followed by
 * the approval pipeline (core/approval-pipeline.js) for final ingest.
 */
export function approveReview(reviewQueueId, { notes, reviewer } = {}) {
  const item = getQueueItem(reviewQueueId);
  if (!item) throw new Error(`Queue item ${reviewQueueId} not found`);

  const allowedFrom = ['needs_review', 'reviewed'];
  if (!allowedFrom.includes(item.status)) {
    throw new Error(`Cannot approve item in status '${item.status}'. Must be: ${allowedFrom.join(', ')}`);
  }

  updateQueueItem(reviewQueueId, {
    status: 'approved',
    review_notes: notes || item.review_notes,
    reviewed_by: reviewer || 'dashboard-user',
    reviewed_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
  });

  log.info({ reviewQueueId, reviewer }, 'Review approved — ready for approval pipeline');
  return { action: 'approve', status: 'approved', reviewQueueId };
}

/**
 * Archive — suppress ingest permanently. Conversation is kept for audit
 * but never enters structured memory.
 */
export function archiveReview(reviewQueueId, { reason, reviewer } = {}) {
  const item = getQueueItem(reviewQueueId);
  if (!item) throw new Error(`Queue item ${reviewQueueId} not found`);

  updateQueueItem(reviewQueueId, {
    status: 'archived',
    review_notes: reason || 'Archived by reviewer',
    reviewed_by: reviewer || 'dashboard-user',
  });

  log.info({ reviewQueueId, reviewer, reason }, 'Review archived — ingest suppressed');
  return { action: 'archive', status: 'archived', reviewQueueId };
}

/**
 * Re-run classification — refresh machine suggestions without losing
 * any manual overrides (relationship, domain, sensitivity, retention,
 * participant tags). Returns item to needs_review so the reviewer can
 * inspect updated suggestions.
 */
export function rerunClassification(reviewQueueId, { classifierFn } = {}) {
  const item = getQueueItem(reviewQueueId);
  if (!item) throw new Error(`Queue item ${reviewQueueId} not found`);

  const db = getDb();

  // Snapshot existing human overrides before re-run
  const existingClassification = db.prepare(
    'SELECT * FROM interaction_classifications WHERE review_queue_id = ? AND human_override = 1'
  ).get(reviewQueueId);

  const overrides = existingClassification
    ? {
        relationship_type: existingClassification.relationship_type,
        domain: existingClassification.domain,
        sensitivity: existingClassification.sensitivity,
        human_reviewer: existingClassification.human_reviewer,
        classification_notes: existingClassification.classification_notes,
      }
    : null;

  // Run classifier if provided (external dependency injection)
  let newSuggestions = null;
  if (typeof classifierFn === 'function') {
    try {
      newSuggestions = classifierFn(item);
      log.info({ reviewQueueId }, 'Re-run classification completed');
    } catch (err) {
      log.error({ reviewQueueId, error: err.message }, 'Re-run classification failed');
      throw err;
    }
  }

  // Reset to needs_review so reviewer can inspect new results
  updateQueueItem(reviewQueueId, { status: 'needs_review' });

  log.info(
    { reviewQueueId, preservedOverrides: !!overrides },
    'Classification re-run complete — item returned to needs_review'
  );

  return {
    action: 'rerun',
    status: 'needs_review',
    reviewQueueId,
    preservedOverrides: overrides,
    newSuggestions,
  };
}

/**
 * Batch approve multiple items.
 */
export function batchApprove(reviewQueueIds, { reviewer } = {}) {
  const results = [];
  for (const id of reviewQueueIds) {
    try {
      results.push(approveReview(id, { reviewer }));
    } catch (e) {
      results.push({ reviewQueueId: id, error: e.message });
    }
  }
  log.info({ count: reviewQueueIds.length, reviewer }, 'Batch approve completed');
  return results;
}

/**
 * Batch archive multiple items.
 */
export function batchArchive(reviewQueueIds, { reviewer, reason } = {}) {
  const results = [];
  for (const id of reviewQueueIds) {
    try {
      results.push(archiveReview(id, { reason, reviewer }));
    } catch (e) {
      results.push({ reviewQueueId: id, error: e.message });
    }
  }
  log.info({ count: reviewQueueIds.length, reviewer }, 'Batch archive completed');
  return results;
}
