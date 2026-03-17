/**
 * Retention Policy Engine — assigns retention classes, calculates expiry, and purges expired records.
 * Retention classes: ephemeral, context, task_candidate, durable_fact, restricted_memory.
 * @module core/retention-engine
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('retention-engine');

const VALID_RETENTION = ['ephemeral', 'context', 'task_candidate', 'durable_fact', 'restricted_memory'];

const RETENTION_DURATIONS = {
  ephemeral: 1,
  context: 7,
  task_candidate: 30,
  durable_fact: 0,
  restricted_memory: 0,
};

/**
 * Assign retention class based on sensitivity, domain, and content signals.
 */
export function assignRetention({ sensitivity, domain, hasOpenTasks, hasFacts }) {
  if (sensitivity === 'restricted') return 'restricted_memory';
  if (hasFacts) return 'durable_fact';
  if (hasOpenTasks) return 'task_candidate';
  if (sensitivity === 'high') return 'context';
  if (domain === 'health' || domain === 'finance') return 'durable_fact';
  if (domain === 'work') return 'context';
  if (sensitivity === 'medium') return 'context';
  if (domain === 'personal' && sensitivity === 'low') return 'ephemeral';
  return 'context';
}

/**
 * Calculate expiry date for a retention class.
 * Returns null for permanent retention.
 */
export function calculateExpiry(retentionClass, fromDate = new Date()) {
  const days = RETENTION_DURATIONS[retentionClass];
  if (days === undefined) {
    log.warn('Unknown retention class, defaulting to context', { retentionClass });
    return calculateExpiry('context', fromDate);
  }
  if (days === 0) return null;
  const expiry = new Date(fromDate);
  expiry.setDate(expiry.getDate() + days);
  return expiry.toISOString();
}

/**
 * Apply retention policy to an interaction record.
 */
export function applyRetentionPolicy(interactionId, { sensitivity, domain, hasOpenTasks, hasFacts, manualOverride }) {
  const db = getDb();

  let retentionClass;
  if (manualOverride && VALID_RETENTION.includes(manualOverride)) {
    retentionClass = manualOverride;
    log.info('Manual retention override applied', { interactionId, retentionClass });
  } else {
    retentionClass = assignRetention({ sensitivity, domain, hasOpenTasks, hasFacts });
    log.info('Auto retention assigned', { interactionId, retentionClass, sensitivity, domain });
  }

  const expiresAt = calculateExpiry(retentionClass);

  const stmt = db.prepare(`
    UPDATE interactions
    SET retention_class = ?, expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const result = stmt.run(retentionClass, expiresAt, interactionId);

  if (result.changes === 0) {
    log.warn('Interaction not found for retention update', { interactionId });
    return null;
  }

  return { retentionClass, expiresAt };
}

/**
 * Get all expired records that need purging.
 */
export function getExpiredRecords() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, retention_class, expires_at FROM interactions
    WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
    ORDER BY expires_at ASC
  `);
  return stmt.all();
}

/**
 * Purge expired records (soft delete: set status to 'purged').
 */
export function purgeExpired() {
  const db = getDb();
  const expired = getExpiredRecords();
  if (expired.length === 0) {
    log.info('No expired records to purge');
    return 0;
  }

  const stmt = db.prepare(`
    UPDATE interactions
    SET status = 'purged', updated_at = datetime('now')
    WHERE id = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `);

  const purgeMany = db.transaction((records) => {
    let count = 0;
    for (const record of records) {
      const result = stmt.run(record.id);
      count += result.changes;
    }
    return count;
  });

  const purged = purgeMany(expired);
  log.info('Expired records purged', { purged });
  return purged;
}

/**
 * Check if an interaction is accessible based on retention policy.
 */
export function isAccessible(interactionId) {
  const db = getDb();
  const stmt = db.prepare('SELECT retention_class, expires_at, status FROM interactions WHERE id = ?');
  const record = stmt.get(interactionId);
  if (!record) return false;
  if (record.status === 'purged') return false;
  if (record.expires_at && new Date(record.expires_at) < new Date()) return false;
  return true;
}

export function isValidRetention(value) {
  return VALID_RETENTION.includes(value);
}

export { VALID_RETENTION, RETENTION_DURATIONS };
