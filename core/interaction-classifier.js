/**
 * Interaction Classifier — classifies interactions by relationship, domain, sensitivity.
 * Supports both auto-classification and human override annotations.
 * Core principle: human override always wins over machine classification.
 * @module core/interaction-classifier
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('interaction-classifier');

const VALID_RELATIONSHIP_TYPES = ['friend', 'family', 'coworker', 'manager', 'client', 'partner', 'vendor', 'mixed', 'unknown'];
const VALID_DOMAINS = ['work', 'personal', 'family', 'finance', 'health', 'mixed', 'unknown'];
const VALID_SENSITIVITY = ['low', 'medium', 'high', 'restricted'];

export function ensureClassificationTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_classifications (
      id TEXT PRIMARY KEY,
      interaction_id TEXT,
      review_queue_id TEXT,
      relationship_type TEXT DEFAULT 'unknown',
      domain TEXT DEFAULT 'unknown',
      sensitivity TEXT DEFAULT 'low',
      topics TEXT DEFAULT '[]',
      auto_classified INTEGER DEFAULT 0,
      human_override INTEGER DEFAULT 0,
      human_reviewer TEXT,
      classification_notes TEXT,
      confidence REAL DEFAULT 0.0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_classifications_interaction ON interaction_classifications(interaction_id);
    CREATE INDEX IF NOT EXISTS idx_classifications_review_queue ON interaction_classifications(review_queue_id);
  `);
  log.info('Classification tables ensured');
}

/**
 * Auto-classify an interaction (machine-generated).
 */
export function autoClassify({ reviewQueueId, interactionId, relationshipType, domain, sensitivity, topics, confidence }) {
  const db = getDb();
  const id = uuidv4();

  const relType = VALID_RELATIONSHIP_TYPES.includes(relationshipType) ? relationshipType : 'unknown';
  const dom = VALID_DOMAINS.includes(domain) ? domain : 'unknown';
  const sens = VALID_SENSITIVITY.includes(sensitivity) ? sensitivity : 'low';
  const topicsJson = JSON.stringify(topics || []);

  const stmt = db.prepare(`
    INSERT INTO interaction_classifications (id, interaction_id, review_queue_id, relationship_type, domain, sensitivity, topics, auto_classified, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  stmt.run(id, interactionId || null, reviewQueueId || null, relType, dom, sens, topicsJson, confidence || 0.0);
  log.info({ id, reviewQueueId, relType, dom }, 'Auto-classification created');
  return id;
}

/**
 * Apply human override to an existing classification.
 * Human annotations always take precedence over auto-classification.
 */
export function humanOverride(classificationId, { relationshipType, domain, sensitivity, topics, reviewer, notes }) {
  const db = getDb();
  const updates = [];
  const params = [];

  if (relationshipType && VALID_RELATIONSHIP_TYPES.includes(relationshipType)) {
    updates.push('relationship_type = ?');
    params.push(relationshipType);
  }
  if (domain && VALID_DOMAINS.includes(domain)) {
    updates.push('domain = ?');
    params.push(domain);
  }
  if (sensitivity && VALID_SENSITIVITY.includes(sensitivity)) {
    updates.push('sensitivity = ?');
    params.push(sensitivity);
  }
  if (topics) {
    updates.push('topics = ?');
    params.push(JSON.stringify(topics));
  }
  if (reviewer) {
    updates.push('human_reviewer = ?');
    params.push(reviewer);
  }
  if (notes) {
    updates.push('classification_notes = ?');
    params.push(notes);
  }

  updates.push('human_override = 1');
  updates.push("updated_at = datetime('now')");
  params.push(classificationId);

  const stmt = db.prepare(`UPDATE interaction_classifications SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);

  if (result.changes === 0) {
    log.warn({ classificationId }, 'Classification not found for override');
    return false;
  }
  log.info({ classificationId, reviewer }, 'Human override applied');
  return true;
}

/**
 * Get classification by ID.
 */
export function getClassification(classificationId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM interaction_classifications WHERE id = ?');
  const row = stmt.get(classificationId);
  if (row) row.topics = JSON.parse(row.topics || '[]');
  return row || null;
}

/**
 * Get classification by review queue ID (latest).
 */
export function getClassificationByReviewQueueId(reviewQueueId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM interaction_classifications WHERE review_queue_id = ? ORDER BY updated_at DESC LIMIT 1');
  const row = stmt.get(reviewQueueId);
  if (row) row.topics = JSON.parse(row.topics || '[]');
  return row || null;
}

/**
 * Get the effective classification (human override wins over auto).
 */
export function getEffectiveClassification(reviewQueueId) {
  const classification = getClassificationByReviewQueueId(reviewQueueId);
  if (!classification) return null;
  return {
    ...classification,
    source: classification.human_override ? 'human' : 'auto',
  };
}

/**
 * List all classifications for an interaction.
 */
export function listClassifications(interactionId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM interaction_classifications WHERE interaction_id = ? ORDER BY created_at DESC');
  return stmt.all(interactionId).map(row => ({ ...row, topics: JSON.parse(row.topics || '[]') }));
}

/**
 * Check if a classification has been human-reviewed.
 */
export function isHumanReviewed(classificationId) {
  const db = getDb();
  const stmt = db.prepare('SELECT human_override FROM interaction_classifications WHERE id = ?');
  const row = stmt.get(classificationId);
  return row ? !!row.human_override : false;
}

export { VALID_RELATIONSHIP_TYPES, VALID_DOMAINS, VALID_SENSITIVITY };

ensureClassificationTables();
