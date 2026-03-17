/**
 * core/interaction-participants-db.js — Final participant mappings
 *
 * Links interactions to people records with role and confidence metadata.
 * Created after human review approves a conversation.
 *
 * Related: HYDRA-116
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('interaction-participants-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS interaction_participants (
    id TEXT PRIMARY KEY,
    interaction_id TEXT NOT NULL,
    person_id TEXT,
    speaker_label TEXT,
    role TEXT DEFAULT 'participant',
    is_self INTEGER DEFAULT 0,
    confidence REAL DEFAULT 0.5,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ip_interaction ON interaction_participants(interaction_id);
  CREATE INDEX IF NOT EXISTS idx_ip_person ON interaction_participants(person_id);
  CREATE INDEX IF NOT EXISTS idx_ip_speaker ON interaction_participants(speaker_label);
`);

log.info('interaction_participants table initialized');

// ── Prepared statements ─────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO interaction_participants
    (id, interaction_id, person_id, speaker_label, role, is_self, confidence, resolved)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getByInteractionStmt = db.prepare(`
  SELECT ip.*, p.canonical_name, p.display_name, p.relationship_type
  FROM interaction_participants ip
  LEFT JOIN people p ON p.id = ip.person_id
  WHERE ip.interaction_id = ?
  ORDER BY ip.is_self DESC, ip.speaker_label ASC
`);

const getByPersonStmt = db.prepare(`
  SELECT ip.*, i.domain_guess, i.started_at, i.summary_normalized
  FROM interaction_participants ip
  JOIN interactions i ON i.id = ip.interaction_id
  WHERE ip.person_id = ?
  ORDER BY i.started_at DESC
  LIMIT ?
`);

const updateStmt = db.prepare(`
  UPDATE interaction_participants
  SET person_id = COALESCE(?, person_id),
      role = COALESCE(?, role),
      is_self = COALESCE(?, is_self),
      confidence = COALESCE(?, confidence),
      resolved = COALESCE(?, resolved)
  WHERE id = ?
`);

const deleteByInteractionStmt = db.prepare(`
  DELETE FROM interaction_participants WHERE interaction_id = ?
`);

const countUnresolvedStmt = db.prepare(`
  SELECT COUNT(*) as count FROM interaction_participants WHERE resolved = 0
`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Add a participant mapping to an interaction.
 * @param {object} participant
 * @returns {string} Participant mapping ID
 */
export function addParticipant(participant) {
  const id = participant.id || uuidv4();
  insertStmt.run(
    id,
    participant.interaction_id,
    participant.person_id || null,
    participant.speaker_label || null,
    participant.role || 'participant',
    participant.is_self ? 1 : 0,
    participant.confidence ?? 0.5,
    participant.resolved ? 1 : 0
  );
  return id;
}

/**
 * Bulk-add participants for an interaction.
 * @param {string} interactionId
 * @param {Array} participants
 * @returns {Array<string>} IDs
 */
export function addParticipants(interactionId, participants) {
  const addMany = db.transaction((items) => {
    return items.map(p => addParticipant({ ...p, interaction_id: interactionId }));
  });
  return addMany(participants);
}

/**
 * Get all participants for an interaction (with person details).
 * @param {string} interactionId
 * @returns {Array}
 */
export function getParticipants(interactionId) {
  return getByInteractionStmt.all(interactionId);
}

/**
 * Get interactions a person participated in.
 * @param {string} personId
 * @param {number} limit
 * @returns {Array}
 */
export function getInteractionsForPerson(personId, limit = 50) {
  return getByPersonStmt.all(personId, limit);
}

/**
 * Update a participant mapping.
 * @param {string} id
 * @param {object} updates
 */
export function updateParticipant(id, updates) {
  updateStmt.run(
    updates.person_id || null,
    updates.role || null,
    updates.is_self !== undefined ? (updates.is_self ? 1 : 0) : null,
    updates.confidence ?? null,
    updates.resolved !== undefined ? (updates.resolved ? 1 : 0) : null,
    id
  );
}

/**
 * Delete all participants for an interaction.
 * @param {string} interactionId
 */
export function deleteParticipants(interactionId) {
  deleteByInteractionStmt.run(interactionId);
}

/**
 * Get count of unresolved participants.
 * @returns {number}
 */
export function getUnresolvedCount() {
  return countUnresolvedStmt.get().count;
}
