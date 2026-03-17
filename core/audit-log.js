/**
 * Audit Log — records reviewer actions, participant changes, overrides,
 * approve/archive decisions, and classifier confidence for traceability.
 *
 * Storage: SQLite table `audit_log` with JSON detail payload.
 *
 * @module core/audit-log
 */
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('audit-log');

/**
 * Initialize audit_log table.
 */
export function initAuditLogTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      reviewer_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  `);
  log.info('audit_log table initialized');
}

/**
 * Valid audit actions.
 */
export const AUDIT_ACTIONS = {
  SAVE_DRAFT: 'save_draft',
  APPROVE: 'approve',
  ARCHIVE: 'archive',
  RERUN: 'rerun',
  PARTICIPANT_ADD: 'participant_add',
  PARTICIPANT_REMOVE: 'participant_remove',
  PARTICIPANT_CHANGE: 'participant_change',
  OVERRIDE_RELATIONSHIP: 'override_relationship',
  OVERRIDE_DOMAIN: 'override_domain',
  OVERRIDE_SENSITIVITY: 'override_sensitivity',
  OVERRIDE_RETENTION: 'override_retention',
  FACT_ADD: 'fact_add',
  FACT_EDIT: 'fact_edit',
  FACT_DELETE: 'fact_delete',
  TASK_ADD: 'task_add',
  TASK_EDIT: 'task_edit',
  TASK_DELETE: 'task_delete',
  CLASSIFIER_RUN: 'classifier_run',
  PIPELINE_COMPLETE: 'pipeline_complete',
};

/**
 * Record an audit log entry.
 * @param {object} params
 * @param {string} params.action - one of AUDIT_ACTIONS
 * @param {string} params.entityType - 'review_queue', 'interaction', 'person', etc.
 * @param {string} params.entityId
 * @param {string} [params.reviewerId]
 * @param {object} [params.details] - arbitrary JSON details
 * @returns {string} audit log entry id
 */
export function recordAudit({ action, entityType, entityId, reviewerId = null, details = {} }) {
  const db = getDb();
  const id = uuid();
  const detailsJson = JSON.stringify(details);

  db.prepare(`
    INSERT INTO audit_log (id, action, entity_type, entity_id, reviewer_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, action, entityType, entityId, reviewerId, detailsJson);

  log.info({ id, action, entityType, entityId }, 'Audit entry recorded');
  return id;
}

/**
 * Query audit log for a specific entity.
 * @param {string} entityType
 * @param {string} entityId
 * @param {object} [options] - limit, offset
 * @returns {Array}
 */
export function getAuditHistory(entityType, entityId, options = {}) {
  const db = getDb();
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  return db.prepare(`
    SELECT id, timestamp, action, entity_type, entity_id, reviewer_id, details_json
    FROM audit_log
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(entityType, entityId, limit, offset).map(row => ({
    ...row,
    details: row.details_json ? JSON.parse(row.details_json) : {},
  }));
}

/**
 * Query audit log by action type.
 */
export function getAuditByAction(action, options = {}) {
  const db = getDb();
  const limit = options.limit || 50;
  const since = options.since || '1970-01-01';

  return db.prepare(`
    SELECT id, timestamp, action, entity_type, entity_id, reviewer_id, details_json
    FROM audit_log
    WHERE action = ? AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(action, since, limit).map(row => ({
    ...row,
    details: row.details_json ? JSON.parse(row.details_json) : {},
  }));
}

/**
 * Get audit summary stats for a time period.
 */
export function getAuditStats(since = '1970-01-01') {
  const db = getDb();
  return db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_log
    WHERE timestamp >= ?
    GROUP BY action
    ORDER BY count DESC
  `).all(since);
}

/**
 * Record a classifier run with confidence details.
 */
export function recordClassifierRun(reviewQueueId, classifierResult) {
  return recordAudit({
    action: AUDIT_ACTIONS.CLASSIFIER_RUN,
    entityType: 'review_queue',
    entityId: reviewQueueId,
    details: {
      confidence: classifierResult.confidence,
      relationship_type: classifierResult.relationship_type,
      domain: classifierResult.domain,
      sensitivity: classifierResult.sensitivity,
      method: classifierResult.method || 'auto',
    },
  });
}

/**
 * Record an override with before/after values.
 */
export function recordOverride(entityId, reviewerId, field, oldValue, newValue) {
  const actionMap = {
    relationship: AUDIT_ACTIONS.OVERRIDE_RELATIONSHIP,
    domain: AUDIT_ACTIONS.OVERRIDE_DOMAIN,
    sensitivity: AUDIT_ACTIONS.OVERRIDE_SENSITIVITY,
    retention: AUDIT_ACTIONS.OVERRIDE_RETENTION,
  };
  return recordAudit({
    action: actionMap[field] || `override_${field}`,
    entityType: 'review_queue',
    entityId,
    reviewerId,
    details: { field, oldValue, newValue },
  });
}
