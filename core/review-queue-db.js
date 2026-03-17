/**
 * core/review-queue-db.js — Audio review queue table and DB helpers
 *
 * Staging area for audio transcripts before they are promoted into
 * final structured memory. Isolates review-stage data from production
 * memory tables.
 *
 * Related: HYDRA-102
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { REVIEW_STATES } from './review-lifecycle.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('review-queue-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS audio_review_queue (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'plaud',
    source_id TEXT,
    audio_path TEXT,
    transcript TEXT,
    summary TEXT,
    language_primary TEXT DEFAULT 'unknown',
    duration_s REAL,
    review_state TEXT NOT NULL DEFAULT '${REVIEW_STATES.RAW}',
    reviewer_notes TEXT,
    human_annotations_json TEXT DEFAULT '{}',
    participant_labels_json TEXT DEFAULT '[]',
    sensitivity TEXT DEFAULT 'medium',
    retention_class TEXT DEFAULT 'context',
    domain_guess TEXT DEFAULT 'unknown',
    relationship_guess TEXT DEFAULT 'unknown',
    suggested_tasks_json TEXT DEFAULT '[]',
    suggested_facts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_arq_review_state ON audio_review_queue(review_state);
  CREATE INDEX IF NOT EXISTS idx_arq_source_type ON audio_review_queue(source_type);
  CREATE INDEX IF NOT EXISTS idx_arq_created_at ON audio_review_queue(created_at);
  CREATE INDEX IF NOT EXISTS idx_arq_language ON audio_review_queue(language_primary);
`);

log.info('audio_review_queue table initialized');

// ── Prepared statements ─────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO audio_review_queue
    (id, source_type, source_id, audio_path, transcript, summary,
     language_primary, duration_s, review_state, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

const getByIdStmt = db.prepare(`
  SELECT * FROM audio_review_queue WHERE id = ?
`);

const listByStateStmt = db.prepare(`
  SELECT * FROM audio_review_queue
  WHERE review_state = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const listAllStmt = db.prepare(`
  SELECT * FROM audio_review_queue
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const listFilteredStmt = db.prepare(`
  SELECT * FROM audio_review_queue
  WHERE (? IS NULL OR review_state = ?)
    AND (? IS NULL OR source_type = ?)
    AND (? IS NULL OR language_primary = ?)
    AND (? IS NULL OR created_at >= ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const updateStateStmt = db.prepare(`
  UPDATE audio_review_queue
  SET review_state = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const updateReviewDataStmt = db.prepare(`
  UPDATE audio_review_queue
  SET reviewer_notes = ?,
      human_annotations_json = ?,
      participant_labels_json = ?,
      sensitivity = ?,
      retention_class = ?,
      domain_guess = ?,
      relationship_guess = ?,
      suggested_tasks_json = ?,
      suggested_facts_json = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const markReviewedStmt = db.prepare(`
  UPDATE audio_review_queue
  SET review_state = ?,
      reviewed_at = datetime('now'),
      reviewed_by = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const countByStateStmt = db.prepare(`
  SELECT review_state, COUNT(*) as count
  FROM audio_review_queue
  GROUP BY review_state
`);

const countPendingStmt = db.prepare(`
  SELECT COUNT(*) as count FROM audio_review_queue
  WHERE review_state IN ('needs_review', 'reviewed')
`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Insert a new item into the review queue.
 * @param {object} item
 * @returns {string} The new item ID
 */
export function saveToReviewQueue(item) {
  const id = item.id || uuidv4();
  insertStmt.run(
    id,
    item.source_type || 'plaud',
    item.source_id || null,
    item.audio_path || null,
    item.transcript || null,
    item.summary || null,
    item.language_primary || 'unknown',
    item.duration_s || null,
    item.review_state || REVIEW_STATES.RAW
  );
  log.info(`Saved to review queue: ${id} (state=${item.review_state || REVIEW_STATES.RAW})`);
  return id;
}

/**
 * Get a single review queue item by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getReviewItem(id) {
  const row = getByIdStmt.get(id);
  return row ? parseReviewRow(row) : null;
}

/**
 * List review queue items by state.
 * @param {string} state
 * @param {number} limit
 * @returns {Array}
 */
export function listByState(state, limit = 50) {
  return listByStateStmt.all(state, limit).map(parseReviewRow);
}

/**
 * List review queue items with filters.
 * @param {object} opts
 * @returns {Array}
 */
export function listReviewQueue({ state = null, source_type = null, language = null, since = null, limit = 50, offset = 0 } = {}) {
  return listFilteredStmt.all(
    state, state,
    source_type, source_type,
    language, language,
    since, since,
    limit, offset
  ).map(parseReviewRow);
}

/**
 * Update the review state of an item.
 * @param {string} id
 * @param {string} newState
 */
export function updateReviewState(id, newState) {
  updateStateStmt.run(newState, id);
  log.info(`Review state updated: ${id} → ${newState}`);
}

/**
 * Save review annotations and metadata edits.
 * @param {string} id
 * @param {object} data
 */
export function updateReviewData(id, data) {
  updateReviewDataStmt.run(
    data.reviewer_notes || null,
    JSON.stringify(data.human_annotations || {}),
    JSON.stringify(data.participant_labels || []),
    data.sensitivity || 'medium',
    data.retention_class || 'context',
    data.domain_guess || 'unknown',
    data.relationship_guess || 'unknown',
    JSON.stringify(data.suggested_tasks || []),
    JSON.stringify(data.suggested_facts || []),
    id
  );
  log.info(`Review data updated: ${id}`);
}

/**
 * Mark an item as reviewed by a human.
 * @param {string} id
 * @param {string} targetState
 * @param {string} reviewerName
 */
export function markReviewed(id, targetState, reviewerName = 'human') {
  markReviewedStmt.run(targetState, reviewerName, id);
  log.info(`Item ${id} marked as ${targetState} by ${reviewerName}`);
}

/**
 * Get counts by review state.
 * @returns {object}
 */
export function getReviewCounts() {
  const rows = countByStateStmt.all();
  const counts = {};
  for (const row of rows) {
    counts[row.review_state] = row.count;
  }
  return counts;
}

/**
 * Get count of items pending review.
 * @returns {number}
 */
export function getPendingCount() {
  return countPendingStmt.get().count;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseReviewRow(row) {
  return {
    ...row,
    human_annotations: safeParse(row.human_annotations_json),
    participant_labels: safeParse(row.participant_labels_json),
    suggested_tasks: safeParse(row.suggested_tasks_json),
    suggested_facts: safeParse(row.suggested_facts_json),
  };
}

function safeParse(val) {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}
