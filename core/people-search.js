/**
 * People Search — advanced search and lightweight edit helpers for people records.
 * Provides fuzzy search across display names, aliases, and linked identities.
 * @module core/people-search
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('people-search');

/**
 * Search people by display name, aliases, or identity display name.
 * Returns matches sorted by relevance (exact > prefix > contains).
 */
export function searchPeopleAdvanced(query, { limit = 20, offset = 0, includeIdentities = true } = {}) {
  if (!query || !query.trim()) return [];
  const db = getDb();
  const q = query.trim().toLowerCase();

  let sql;
  if (includeIdentities) {
    sql = db.prepare(`
      SELECT DISTINCT p.id, p.display_name, p.aliases, p.notes, p.created_at, p.updated_at,
        CASE
          WHEN LOWER(p.display_name) = ? THEN 3
          WHEN LOWER(p.display_name) LIKE ? THEN 2
          WHEN LOWER(p.display_name) LIKE ? OR LOWER(p.aliases) LIKE ? THEN 1
          ELSE 0
        END AS relevance
      FROM people p
      LEFT JOIN person_identities pi ON pi.person_id = p.id
      WHERE LOWER(p.display_name) LIKE ?
        OR LOWER(p.aliases) LIKE ?
        OR LOWER(pi.display_name) LIKE ?
        OR LOWER(pi.platform_id) LIKE ?
      ORDER BY relevance DESC, p.display_name ASC
      LIMIT ? OFFSET ?
    `);
    const pattern = `%${q}%`;
    const prefixPattern = `${q}%`;
    return sql.all(q, prefixPattern, pattern, pattern, pattern, pattern, pattern, pattern, limit, offset);
  } else {
    sql = db.prepare(`
      SELECT p.id, p.display_name, p.aliases, p.notes, p.created_at, p.updated_at,
        CASE
          WHEN LOWER(p.display_name) = ? THEN 3
          WHEN LOWER(p.display_name) LIKE ? THEN 2
          WHEN LOWER(p.display_name) LIKE ? OR LOWER(p.aliases) LIKE ? THEN 1
          ELSE 0
        END AS relevance
      FROM people p
      WHERE LOWER(p.display_name) LIKE ? OR LOWER(p.aliases) LIKE ?
      ORDER BY relevance DESC, p.display_name ASC
      LIMIT ? OFFSET ?
    `);
    const pattern = `%${q}%`;
    const prefixPattern = `${q}%`;
    return sql.all(q, prefixPattern, pattern, pattern, pattern, pattern, limit, offset);
  }
}

/**
 * Get a person with all their identities and interaction count.
 */
export function getPersonWithDetails(personId) {
  const db = getDb();

  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;

  const identities = db.prepare('SELECT * FROM person_identities WHERE person_id = ? ORDER BY platform ASC').all(personId);

  const interactionCount = db.prepare(
    'SELECT COUNT(*) AS count FROM interaction_participants WHERE person_id = ?'
  ).get(personId);

  return {
    ...person,
    identities,
    interactionCount: interactionCount?.count || 0,
  };
}

/**
 * Lightweight edit: update person fields (display_name, aliases, notes).
 */
export function editPerson(personId, updates) {
  const db = getDb();
  const fields = [];
  const params = [];

  if (updates.displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(updates.displayName);
  }
  if (updates.aliases !== undefined) {
    fields.push('aliases = ?');
    params.push(updates.aliases);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    params.push(updates.notes);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  params.push(personId);

  const stmt = db.prepare(`UPDATE people SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);

  if (result.changes === 0) {
    log.warn({ personId }, 'Person not found for edit');
    return false;
  }
  log.info({ personId }, 'Person edited');
  return true;
}

/**
 * Merge two people: move all identities and participant references from source to target.
 */
export function mergePeople(targetId, sourceId) {
  const db = getDb();

  const mergeOp = db.transaction(() => {
    // Move identities
    db.prepare('UPDATE person_identities SET person_id = ? WHERE person_id = ?').run(targetId, sourceId);
    // Move participant references
    db.prepare('UPDATE interaction_participants SET person_id = ? WHERE person_id = ?').run(targetId, sourceId);
    // Delete source person
    db.prepare('DELETE FROM people WHERE id = ?').run(sourceId);
  });

  mergeOp();
  log.info({ targetId, sourceId }, 'People merged');
  return true;
}
