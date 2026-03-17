/**
 * core/interactions-db.js — Final classified conversation records
 *
 * After a conversation is approved through the review queue, it gets a
 * permanent structured record here. This is the final destination for
 * classified conversation data.
 *
 * Related: HYDRA-115
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('interactions-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'audio',
    source_id TEXT,
    channel TEXT,
    started_at TEXT,
    ended_at TEXT,
    language_primary TEXT DEFAULT 'unknown',
    transcription_confidence REAL,
    summary_confidence REAL,
    domain_guess TEXT DEFAULT 'unknown',
    domain_confidence REAL,
    relationship_guess TEXT DEFAULT 'unknown',
    relationship_confidence REAL,
    sensitivity TEXT DEFAULT 'medium',
    retention_class TEXT DEFAULT 'context',
    review_queue_id TEXT,
    transcript_raw TEXT,
    summary_normalized TEXT,
    reviewer_notes TEXT,
    human_overrides_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (review_queue_id) REFERENCES audio_review_queue(id)
  );

  CREATE INDEX IF NOT EXISTS idx_interactions_source ON interactions(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_domain ON interactions(domain_guess);
  CREATE INDEX IF NOT EXISTS idx_interactions_relationship ON interactions(relationship_guess);
  CREATE INDEX IF NOT EXISTS idx_interactions_sensitivity ON interactions(sensitivity);
  CREATE INDEX IF NOT EXISTS idx_interactions_retention ON interactions(retention_class);
  CREATE INDEX IF NOT EXISTS idx_interactions_language ON interactions(language_primary);
  CREATE INDEX IF NOT EXISTS idx_interactions_created ON interactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_interactions_review_queue ON interactions(review_queue_id);
`);

log.info('interactions table initialized');

// ── Valid values ────────────────────────────────────────────────────

export const DOMAIN_VALUES = Object.freeze([
  'work', 'personal', 'family', 'finance', 'health', 'mixed', 'unknown'
]);

export const SENSITIVITY_VALUES = Object.freeze([
  'low', 'medium', 'high', 'restricted'
]);

export const RETENTION_CLASSES = Object.freeze([
  'ephemeral', 'context', 'task_candidate', 'durable_fact', 'restricted_memory'
]);

// ── Prepared statements ─────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO interactions
    (id, source_type, source_id, channel, started_at, ended_at,
     language_primary, transcription_confidence, summary_confidence,
     domain_guess, domain_confidence, relationship_guess, relationship_confidence,
     sensitivity, retention_class, review_queue_id,
     transcript_raw, summary_normalized, reviewer_notes, human_overrides_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`SELECT * FROM interactions WHERE id = ?`);

const getByReviewQueueIdStmt = db.prepare(`
  SELECT * FROM interactions WHERE review_queue_id = ?
`);

const listStmt = db.prepare(`
  SELECT * FROM interactions
  WHERE (? IS NULL OR domain_guess = ?)
    AND (? IS NULL OR relationship_guess = ?)
    AND (? IS NULL OR sensitivity = ?)
    AND (? IS NULL OR language_primary = ?)
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const countStmt = db.prepare(`SELECT COUNT(*) as count FROM interactions`);

const searchByDateRangeStmt = db.prepare(`
  SELECT * FROM interactions
  WHERE started_at >= ? AND started_at <= ?
  ORDER BY started_at DESC
  LIMIT ?
`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a new interaction record.
 * @param {object} interaction
 * @returns {string} Interaction ID
 */
export function createInteraction(interaction) {
  const id = interaction.id || uuidv4();
  insertStmt.run(
    id,
    interaction.source_type || 'audio',
    interaction.source_id || null,
    interaction.channel || null,
    interaction.started_at || null,
    interaction.ended_at || null,
    interaction.language_primary || 'unknown',
    interaction.transcription_confidence ?? null,
    interaction.summary_confidence ?? null,
    interaction.domain_guess || 'unknown',
    interaction.domain_confidence ?? null,
    interaction.relationship_guess || 'unknown',
    interaction.relationship_confidence ?? null,
    interaction.sensitivity || 'medium',
    interaction.retention_class || 'context',
    interaction.review_queue_id || null,
    interaction.transcript_raw || null,
    interaction.summary_normalized || null,
    interaction.reviewer_notes || null,
    JSON.stringify(interaction.human_overrides || {})
  );
  log.info(`Created interaction: ${id} (domain=${interaction.domain_guess}, rel=${interaction.relationship_guess})`);
  return id;
}

/**
 * Get an interaction by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getInteraction(id) {
  const row = getByIdStmt.get(id);
  return row ? parseInteractionRow(row) : null;
}

/**
 * Get interaction by review queue ID.
 * @param {string} reviewQueueId
 * @returns {object|null}
 */
export function getInteractionByReviewQueueId(reviewQueueId) {
  const row = getByReviewQueueIdStmt.get(reviewQueueId);
  return row ? parseInteractionRow(row) : null;
}

/**
 * List interactions with optional filters.
 * @param {object} opts
 * @returns {Array}
 */
export function listInteractions({ domain = null, relationship = null, sensitivity = null, language = null, limit = 50, offset = 0 } = {}) {
  return listStmt.all(
    domain, domain,
    relationship, relationship,
    sensitivity, sensitivity,
    language, language,
    limit, offset
  ).map(parseInteractionRow);
}

/**
 * Search interactions by date range.
 * @param {string} from - ISO date
 * @param {string} to - ISO date
 * @param {number} limit
 * @returns {Array}
 */
export function searchInteractionsByDate(from, to, limit = 50) {
  return searchByDateRangeStmt.all(from, to, limit).map(parseInteractionRow);
}

/**
 * Get total interaction count.
 * @returns {number}
 */
export function getInteractionCount() {
  return countStmt.get().count;
}

function parseInteractionRow(row) {
  return {
    ...row,
    human_overrides: safeParse(row.human_overrides_json),
  };
}

function safeParse(val) {
  if (!val) return {};
  try { return JSON.parse(val); } catch { return {}; }
}
