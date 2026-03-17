/**
 * core/memory-facts-db.js — Approved durable facts and extracted tasks
 *
 * Only approved (human-reviewed) facts and tasks are written here.
 * These are the "beliefs" derived from reviewed evidence.
 *
 * Related: HYDRA-117
 */
import { db } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('memory-facts-db');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_facts (
    id TEXT PRIMARY KEY,
    interaction_id TEXT,
    person_id TEXT,
    fact_text TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    confidence REAL DEFAULT 0.5,
    source_type TEXT DEFAULT 'audio',
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (interaction_id) REFERENCES interactions(id),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tasks_extracted (
    id TEXT PRIMARY KEY,
    interaction_id TEXT,
    person_id TEXT,
    task_text TEXT NOT NULL,
    owner TEXT,
    due_date TEXT,
    status TEXT DEFAULT 'open',
    priority TEXT DEFAULT 'normal',
    confidence REAL DEFAULT 0.5,
    source_type TEXT DEFAULT 'audio',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (interaction_id) REFERENCES interactions(id),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mf_interaction ON memory_facts(interaction_id);
  CREATE INDEX IF NOT EXISTS idx_mf_person ON memory_facts(person_id);
  CREATE INDEX IF NOT EXISTS idx_mf_category ON memory_facts(category);
  CREATE INDEX IF NOT EXISTS idx_te_interaction ON tasks_extracted(interaction_id);
  CREATE INDEX IF NOT EXISTS idx_te_person ON tasks_extracted(person_id);
  CREATE INDEX IF NOT EXISTS idx_te_status ON tasks_extracted(status);
  CREATE INDEX IF NOT EXISTS idx_te_owner ON tasks_extracted(owner);
`);

log.info('memory_facts and tasks_extracted tables initialized');

// ── Prepared statements ─────────────────────────────────────────────

const insertFactStmt = db.prepare(`
  INSERT INTO memory_facts (id, interaction_id, person_id, fact_text, category, confidence, source_type, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertTaskStmt = db.prepare(`
  INSERT INTO tasks_extracted (id, interaction_id, person_id, task_text, owner, due_date, status, priority, confidence, source_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getFactsByInteractionStmt = db.prepare(`
  SELECT * FROM memory_facts WHERE interaction_id = ? ORDER BY created_at ASC
`);

const getFactsByPersonStmt = db.prepare(`
  SELECT mf.*, i.domain_guess, i.started_at
  FROM memory_facts mf
  LEFT JOIN interactions i ON i.id = mf.interaction_id
  WHERE mf.person_id = ?
  ORDER BY mf.created_at DESC
  LIMIT ?
`);

const getTasksByInteractionStmt = db.prepare(`
  SELECT * FROM tasks_extracted WHERE interaction_id = ? ORDER BY created_at ASC
`);

const getOpenTasksStmt = db.prepare(`
  SELECT te.*, p.canonical_name as person_name
  FROM tasks_extracted te
  LEFT JOIN people p ON p.id = te.person_id
  WHERE te.status = 'open'
  ORDER BY te.created_at DESC
  LIMIT ?
`);

const updateTaskStatusStmt = db.prepare(`
  UPDATE tasks_extracted
  SET status = ?,
      completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END,
      updated_at = datetime('now')
  WHERE id = ?
`);

const countFactsStmt = db.prepare(`SELECT COUNT(*) as count FROM memory_facts`);
const countOpenTasksStmt = db.prepare(`SELECT COUNT(*) as count FROM tasks_extracted WHERE status = 'open'`);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a durable fact from a reviewed interaction.
 * @param {object} fact
 * @returns {string} Fact ID
 */
export function createFact(fact) {
  const id = fact.id || uuidv4();
  insertFactStmt.run(
    id,
    fact.interaction_id || null,
    fact.person_id || null,
    fact.fact_text,
    fact.category || 'general',
    fact.confidence ?? 0.5,
    fact.source_type || 'audio',
    fact.verified ? 1 : 0
  );
  log.info(`Created fact: ${id}`);
  return id;
}

/**
 * Bulk-create facts for an interaction.
 * @param {string} interactionId
 * @param {Array} facts
 * @returns {Array<string>} Fact IDs
 */
export function createFacts(interactionId, facts) {
  const tx = db.transaction((items) => {
    return items.map(f => createFact({ ...f, interaction_id: interactionId }));
  });
  return tx(facts);
}

/**
 * Create an extracted task from a reviewed interaction.
 * @param {object} task
 * @returns {string} Task ID
 */
export function createTask(task) {
  const id = task.id || uuidv4();
  insertTaskStmt.run(
    id,
    task.interaction_id || null,
    task.person_id || null,
    task.task_text,
    task.owner || null,
    task.due_date || null,
    task.status || 'open',
    task.priority || 'normal',
    task.confidence ?? 0.5,
    task.source_type || 'audio'
  );
  log.info(`Created task: ${id}`);
  return id;
}

/**
 * Bulk-create tasks for an interaction.
 * @param {string} interactionId
 * @param {Array} tasks
 * @returns {Array<string>} Task IDs
 */
export function createTasks(interactionId, tasks) {
  const tx = db.transaction((items) => {
    return items.map(t => createTask({ ...t, interaction_id: interactionId }));
  });
  return tx(tasks);
}

export function getFactsByInteraction(interactionId) {
  return getFactsByInteractionStmt.all(interactionId);
}

export function getFactsByPerson(personId, limit = 50) {
  return getFactsByPersonStmt.all(personId, limit);
}

export function getTasksByInteraction(interactionId) {
  return getTasksByInteractionStmt.all(interactionId);
}

export function getOpenTasks(limit = 50) {
  return getOpenTasksStmt.all(limit);
}

export function updateTaskStatus(id, status) {
  updateTaskStatusStmt.run(status, status, id);
}

export function getFactCount() { return countFactsStmt.get().count; }
export function getOpenTaskCount() { return countOpenTasksStmt.get().count; }
