/**
 * core/person-identities-db.js — Cross-channel identity mapping
 *
 * Maps a canonical person to all their known identities across channels
 * (Slack, phone, email, WhatsApp, Telegram, Discord, Plaud speaker hints).
 *
 * Related: HYDRA-107
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('person-identities-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS person_identities (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    identity_type TEXT NOT NULL,
    identity_value TEXT NOT NULL,
    display_label TEXT,
    confidence REAL DEFAULT 0.5,
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
    UNIQUE(identity_type, identity_value)
  );

  CREATE INDEX IF NOT EXISTS idx_pi_person ON person_identities(person_id);
  CREATE INDEX IF NOT EXISTS idx_pi_type_value ON person_identities(identity_type, identity_value);
  CREATE INDEX IF NOT EXISTS idx_pi_type ON person_identities(identity_type);
`);

log.info('person_identities table initialized');

// ── Valid identity types ────────────────────────────────────────────

export const IDENTITY_TYPES = Object.freeze([
  'email', 'phone', 'slack', 'whatsapp', 'telegram',
  'discord', 'github', 'linkedin', 'plaud_speaker',
  'whisperx_speaker', 'other'
]);

// ── Prepared statements ─────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO person_identities
    (id, person_id, identity_type, identity_value, display_label, confidence, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getByPersonStmt = db.prepare(`
  SELECT * FROM person_identities WHERE person_id = ? ORDER BY identity_type ASC
`);

const findByIdentityStmt = db.prepare(`
  SELECT pi.*, p.canonical_name, p.display_name, p.relationship_type
  FROM person_identities pi
  JOIN people p ON p.id = pi.person_id
  WHERE pi.identity_type = ? AND pi.identity_value = ?
`);

const searchIdentitiesStmt = db.prepare(`
  SELECT pi.*, p.canonical_name, p.display_name
  FROM person_identities pi
  JOIN people p ON p.id = pi.person_id
  WHERE pi.identity_value LIKE ?
  ORDER BY pi.confidence DESC
  LIMIT ?
`);

const updateStmt = db.prepare(`
  UPDATE person_identities
  SET display_label = COALESCE(?, display_label),
      confidence = COALESCE(?, confidence),
      verified = COALESCE(?, verified),
      updated_at = datetime('now')
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM person_identities WHERE id = ?`);

const deleteByPersonStmt = db.prepare(`DELETE FROM person_identities WHERE person_id = ?`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Add an identity to a person.
 * @param {object} identity
 * @returns {string} Identity ID
 */
export function addIdentity(identity) {
  const id = identity.id || uuidv4();
  insertStmt.run(
    id,
    identity.person_id,
    identity.identity_type,
    identity.identity_value,
    identity.display_label || null,
    identity.confidence ?? 0.5,
    identity.verified ? 1 : 0
  );
  log.info(`Added identity: ${identity.identity_type}=${identity.identity_value} for person ${identity.person_id}`);
  return id;
}

/**
 * Get all identities for a person.
 * @param {string} personId
 * @returns {Array}
 */
export function getIdentitiesForPerson(personId) {
  return getByPersonStmt.all(personId);
}

/**
 * Find a person by identity (e.g., email, phone, Slack ID).
 * @param {string} type
 * @param {string} value
 * @returns {object|null}
 */
export function findPersonByIdentity(type, value) {
  return findByIdentityStmt.get(type, value) || null;
}

/**
 * Search identities by value substring.
 * @param {string} query
 * @param {number} limit
 * @returns {Array}
 */
export function searchIdentities(query, limit = 20) {
  return searchIdentitiesStmt.all(`%${query}%`, limit);
}

/**
 * Update an identity record.
 * @param {string} id
 * @param {object} updates
 */
export function updateIdentity(id, updates) {
  updateStmt.run(
    updates.display_label || null,
    updates.confidence ?? null,
    updates.verified !== undefined ? (updates.verified ? 1 : 0) : null,
    id
  );
}

/**
 * Delete an identity by ID.
 * @param {string} id
 */
export function deleteIdentity(id) {
  deleteStmt.run(id);
}

/**
 * Delete all identities for a person.
 * @param {string} personId
 */
export function deleteAllIdentities(personId) {
  deleteByPersonStmt.run(personId);
}
