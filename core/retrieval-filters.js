/**
 * Retrieval Filters — extends memory search with structured filtering
 * so agents only access contextually appropriate data.
 *
 * Restricted content is excluded from generic search by default.
 *
 * @module core/retrieval-filters
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('retrieval-filters');

export const FILTER_ENUMS = {
  domain: ['work', 'personal', 'family', 'finance', 'health', 'mixed', 'unknown'],
  relationship: ['friend', 'family', 'coworker', 'manager', 'client', 'partner', 'vendor', 'mixed', 'unknown'],
  sensitivity: ['low', 'medium', 'high', 'restricted'],
  retentionClass: ['ephemeral', 'context', 'task_candidate', 'durable_fact', 'restricted_memory'],
};

/**
 * Build a SQL WHERE clause from filter options.
 * @param {object} filters
 * @returns  clause: string, params: any[] 
 */
export function buildFilterClause(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.domain) {
    conditions.push('i.domain = ?');
    params.push(filters.domain);
  }

  if (filters.relationship) {
    conditions.push('i.relationship_type = ?');
    params.push(filters.relationship);
  }

  if (filters.sensitivity) {
    if (Array.isArray(filters.sensitivity)) {
      const placeholders = filters.sensitivity.map(() => '?').join(', ');
      conditions.push(`i.sensitivity IN (${placeholders})`);
      params.push(...filters.sensitivity);
    } else {
      conditions.push('i.sensitivity = ?');
      params.push(filters.sensitivity);
    }
  }

  if (filters.retentionClass) {
    conditions.push('i.retention_class = ?');
    params.push(filters.retentionClass);
  }

  if (filters.language) {
    conditions.push('i.language = ?');
    params.push(filters.language);
  }

  if (filters.participantPersonId) {
    conditions.push(
      'i.id IN (SELECT interaction_id FROM interaction_participants WHERE person_id = ?)'
    );
    params.push(filters.participantPersonId);
  }

  // Exclude restricted by default unless explicitly included
  if (!filters.includeRestricted) {
    conditions.push("i.sensitivity != 'restricted'");
  }

  // Exclude expired by default
  if (!filters.includeExpired) {
    conditions.push("(i.expires_at IS NULL OR i.expires_at > datetime('now'))");
  }

  const clause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { clause, params };
}

/**
 * Query interactions with structured filters.
 * @param {object} filters - domain, relationship, sensitivity, retentionClass, language, participantPersonId, includeRestricted, includeExpired
 * @param {object} [options] - limit, offset, orderBy
 * @returns {Array} matching interaction records
 */
export function queryInteractions(filters = {}, options = {}) {
  const { clause, params } = buildFilterClause(filters);
  const limit = options.limit || 50;
  const offset = options.offset || 0;
  const orderBy = options.orderBy || 'i.created_at DESC';

  const db = getDb();
  const sql = `SELECT i.* FROM interactions i ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const results = db.prepare(sql).all(...params);
  log.info({ filters, count: results.length }, 'Filtered interaction query');
  return results;
}

/**
 * Query interactions by a specific person (participant).
 */
export function queryByPerson(personId, filters = {}, options = {}) {
  return queryInteractions({ ...filters, participantPersonId: personId }, options);
}

/**
 * Query interactions with restricted content explicitly included.
 * Requires explicit opt-in for safety.
 */
export function queryWithRestricted(filters = {}, options = {}) {
  return queryInteractions({ ...filters, includeRestricted: true }, options);
}

/**
 * Get filter statistics — counts per domain, relationship, sensitivity.
 */
export function getFilterStats() {
  const db = getDb();
  const domainStats = db.prepare(
    "SELECT domain, COUNT(*) as count FROM interactions WHERE sensitivity != 'restricted' GROUP BY domain"
  ).all();
  const relationshipStats = db.prepare(
    "SELECT relationship_type, COUNT(*) as count FROM interactions WHERE sensitivity != 'restricted' GROUP BY relationship_type"
  ).all();
  const sensitivityStats = db.prepare(
    'SELECT sensitivity, COUNT(*) as count FROM interactions GROUP BY sensitivity'
  ).all();

  return { domain: domainStats, relationship: relationshipStats, sensitivity: sensitivityStats };
}
