/**
 * core/people-db.js — Canonical people table and DB helpers
 *
 * Stores known contacts so speakers in conversations can be resolved
 * to real people rather than anonymous speaker labels.
 *
 * Related: HYDRA-106
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('people-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    display_name TEXT,
    relationship_type TEXT DEFAULT 'unknown',
    organization TEXT,
    notes TEXT,
    confidence REAL DEFAULT 0.5,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_people_name ON people(canonical_name);
  CREATE INDEX IF NOT EXISTS idx_people_relationship ON people(relationship_type);
  CREATE INDEX IF NOT EXISTS idx_people_org ON people(organization);
`);

log.info('people table initialized');

// ── Valid values ────────────────────────────────────────────────────

export const RELATIONSHIP_TYPES = Object.freeze([
  'friend', 'family', 'coworker', 'manager', 'client',
  'partner', 'vendor', 'mixed', 'unknown'
]);

// ── Prepared statements ─────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO people (id, canonical_name, display_name, relationship_type, organization, notes, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getByIdStmt = db.prepare(`SELECT * FROM people WHERE id = ?`);

const searchByNameStmt = db.prepare(`
  SELECT * FROM people
  WHERE canonical_name LIKE ? OR display_name LIKE ?
  ORDER BY canonical_name ASC
  LIMIT ?
`);

const listAllStmt = db.prepare(`
  SELECT * FROM people ORDER BY updated_at DESC LIMIT ? OFFSET ?
`);

const updateStmt = db.prepare(`
  UPDATE people
  SET canonical_name = COALESCE(?, canonical_name),
      display_name = COALESCE(?, display_name),
      relationship_type = COALESCE(?, relationship_type),
      organization = COALESCE(?, organization),
      notes = COALESCE(?, notes),
      confidence = COALESCE(?, confidence),
      updated_at = datetime('now')
  WHERE id = ?
`);

const deleteStmt = db.prepare(`DELETE FROM people WHERE id = ?`);

const countStmt = db.prepare(`SELECT COUNT(*) as count FROM people`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a new person record.
 * @param {object} person
 * @returns {string} Person ID
 */
export function createPerson(person) {
  const id = person.id || uuidv4();
  insertStmt.run(
    id,
    person.canonical_name || person.name,
    person.display_name || null,
    person.relationship_type || 'unknown',
    person.organization || null,
    person.notes || null,
    person.confidence ?? 0.5
  );
  log.info(`Created person: ${id} (${person.canonical_name || person.name})`);
  return id;
}

/**
 * Get a person by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getPerson(id) {
  return getByIdStmt.get(id) || null;
}

/**
 * Search people by name or display name.
 * @param {string} query
 * @param {number} limit
 * @returns {Array}
 */
export function searchPeople(query, limit = 20) {
  const pattern = `%${query}%`;
  return searchByNameStmt.all(pattern, pattern, limit);
}

/**
 * List all people with pagination.
 * @param {object} opts
 * @returns {Array}
 */
export function listPeople({ limit = 50, offset = 0 } = {}) {
  return listAllStmt.all(limit, offset);
}

/**
 * Update a person record. Only non-null fields are updated.
 * @param {string} id
 * @param {object} updates
 */
export function updatePerson(id, updates) {
  updateStmt.run(
    updates.canonical_name || null,
    updates.display_name || null,
    updates.relationship_type || null,
    updates.organization || null,
    updates.notes || null,
    updates.confidence ?? null,
    id
  );
  log.info(`Updated person: ${id}`);
}

/**
 * Delete a person by ID.
 * @param {string} id
 */
export function deletePerson(id) {
  deleteStmt.run(id);
  log.info(`Deleted person: ${id}`);
}

/**
 * Get total people count.
 * @returns {number}
 */
export function getPeopleCount() {
  return countStmt.get().count;
}
