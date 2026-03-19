/**
 * Approval Pipeline — converts a reviewed, annotated conversation into
 * final structured records and enriched vector memory.
 *
 * Flow:
 *   reviewed item
 *     → merge human annotations + machine suggestions
 *     → create interaction record
 *     → create participant mappings
 *     → create facts/tasks
 *     → write enriched vector memory
 *     → mark item indexed
 *
 * Triggered by the "Approve & Ingest" action from review-actions.js.
 * @module core/approval-pipeline
 */
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { getQueueItem, updateQueueItem } from './review-queue-db.js';
import { createInteraction } from './interactions-db.js';
import { addParticipant } from './interaction-participants-db.js';
import { addFact, addTask } from './memory-facts-db.js';
import { getTranscriptByReviewQueueId } from './transcript-store.js';
import { getEffectiveClassification } from './interaction-classifier.js';
import { createLogger } from './logger.js';

const log = createLogger('approval-pipeline');

/**
 * Run the full approval pipeline for a single review queue item.
 * @param {string} reviewQueueId
 * @param {object} options
 * @param {Function} [options.vectorWriteFn] - optional fn(metadata) to write to vector memory
 * @returns {object} pipeline result with interaction id, counts, status
 */
export async function runApprovalPipeline(reviewQueueId, { vectorWriteFn } = {}) {
  const item = getQueueItem(reviewQueueId);
  if (!item) throw new Error(`Queue item ${reviewQueueId} not found`);
  if (item.status !== 'approved') {
    throw new Error(`Item must be approved before running pipeline. Current status: ${item.status}`);
  }

  log.info({ reviewQueueId }, 'Starting approval pipeline');

  const db = getDb();
  const transcript = getTranscriptByReviewQueueId
    ? getTranscriptByReviewQueueId(reviewQueueId)
    : null;

  // 1. Get effective classification (human override > auto)
  const classification = getEffectiveClassification(reviewQueueId);

  // 2. Create interaction record
  const interactionId = createInteraction({
    reviewQueueId,
    source: item.source || 'plaud-note',
    summary: transcript?.normalized_summary || item.summary || '',
    relationshipType: classification?.relationship_type || 'unknown',
    domain: classification?.domain || 'unknown',
    sensitivity: classification?.sensitivity || 'low',
    retentionClass: classification?.retention_class || 'context',
    language: item.language || transcript?.language || 'unknown',
    status: 'active',
  });

  log.info({ reviewQueueId, interactionId }, 'Interaction record created');

  // 3. Create participant mappings from review-stage data
  let participantCount = 0;
  try {
    const reviewParticipants = db.prepare(
      'SELECT * FROM interaction_participants WHERE interaction_id = ?'
    ).all(reviewQueueId);

    // Also check if participants were stored against review queue id
    const queueParticipants = db.prepare(
      `SELECT * FROM interaction_participants WHERE interaction_id = ?`
    ).all(reviewQueueId);

    const participants = reviewParticipants.length > 0 ? reviewParticipants : queueParticipants;

    for (const p of participants) {
      addParticipant({
        interactionId,
        personId: p.person_id || null,
        speakerLabel: p.speaker_label,
        role: p.role || 'participant',
      });
      participantCount++;
    }
  } catch (err) {
    log.warn({ reviewQueueId, error: err.message }, 'Could not migrate participants');
  }

  // 4. Create facts from reviewed/approved facts
  let factCount = 0;
  try {
    const reviewFacts = db.prepare(
      'SELECT * FROM memory_facts WHERE interaction_id = ?'
    ).all(reviewQueueId);

    for (const f of reviewFacts) {
      addFact({
        interactionId,
        factType: f.fact_type,
        content: f.content,
        confidence: f.confidence,
        source: f.source || 'human-reviewed',
      });
      factCount++;
    }
  } catch (err) {
    log.warn({ reviewQueueId, error: err.message }, 'Could not migrate facts');
  }

  // 5. Create tasks from reviewed/approved tasks
  let taskCount = 0;
  try {
    const reviewTasks = db.prepare(
      'SELECT * FROM tasks_extracted WHERE interaction_id = ?'
    ).all(reviewQueueId);

    for (const t of reviewTasks) {
      addTask({
        interactionId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        dueDate: t.due_date,
        status: t.status || 'open',
        assignedTo: t.assigned_to,
      });
      taskCount++;
    }
  } catch (err) {
    log.warn({ reviewQueueId, error: err.message }, 'Could not migrate tasks');
  }

  // 6. Write enriched vector memory if writer provided
  let vectorWritten = false;
  if (typeof vectorWriteFn === 'function') {
    try {
      await vectorWriteFn({
        interactionId,
        reviewQueueId,
        text: transcript?.normalized_summary || item.summary || '',
        rawTranscript: transcript?.raw_transcript || '',
        metadata: {
          language: item.language || 'unknown',
          domain: classification?.domain || 'unknown',
          relationship: classification?.relationship_type || 'unknown',
          sensitivity: classification?.sensitivity || 'low',
          retentionClass: classification?.retention_class || 'context',
          source: item.source || 'plaud-note',
          participantCount,
          factCount,
          taskCount,
        },
      });
      vectorWritten = true;
      log.info({ interactionId }, 'Vector memory written');
    } catch (err) {
      log.error({ interactionId, error: err.message }, 'Vector memory write failed');
    }
  }

  // 7. Mark item as indexed
  updateQueueItem(reviewQueueId, {
    status: 'indexed',
    indexed_at: new Date().toISOString(),
  });

  const result = {
    reviewQueueId,
    interactionId,
    participantCount,
    factCount,
    taskCount,
    vectorWritten,
    status: 'indexed',
  };

  log.info(result, 'Approval pipeline completed');
  return result;
}

/**
 * Run approval pipeline for multiple items.
 */
export async function batchApprovalPipeline(reviewQueueIds, options = {}) {
  const results = [];
  for (const id of reviewQueueIds) {
    try {
      const result = await runApprovalPipeline(id, options);
      results.push(result);
    } catch (err) {
      results.push({ reviewQueueId: id, error: err.message });
      log.error({ reviewQueueId: id, error: err.message }, 'Batch approval item failed');
    }
  }
  return results;
}
