/**
 * Dashboard Facts Editor — Express routes for viewing and editing extracted tasks/facts.
 * Allows reviewers to edit, add, or remove extracted memory facts and tasks before approval.
 * @module scripts/dashboard-facts-editor
 */
import { Router } from 'express';
import { getDb } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('dashboard-facts-editor');
const router = Router();

/**
 * GET /review/api/facts/:reviewQueueId — List extracted facts and tasks
 */
router.get('/api/facts/:reviewQueueId', (req, res) => {
  try {
    const db = getDb();
    const facts = db.prepare('SELECT * FROM memory_facts WHERE interaction_id = ? ORDER BY created_at ASC').all(req.params.reviewQueueId);
    const tasks = db.prepare('SELECT * FROM tasks_extracted WHERE interaction_id = ? ORDER BY created_at ASC').all(req.params.reviewQueueId);
    res.json({ facts, tasks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /review/api/facts/:reviewQueueId — Add a new fact
 * Body: { factType, content, confidence?, source? }
 */
router.post('/api/facts/:reviewQueueId', (req, res) => {
  try {
    const db = getDb();
    const { factType, content, confidence, source } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO memory_facts (id, interaction_id, fact_type, content, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.reviewQueueId, factType || 'general', content, confidence || 1.0, source || 'human');
    log.info({ id, reviewQueueId: req.params.reviewQueueId }, 'Fact added');
    res.json({ id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /review/api/facts/item/:factId — Edit a fact
 * Body: { content?, factType?, confidence? }
 */
router.put('/api/facts/item/:factId', (req, res) => {
  try {
    const db = getDb();
    const updates = [];
    const params = [];
    if (req.body.content !== undefined) { updates.push('content = ?'); params.push(req.body.content); }
    if (req.body.factType !== undefined) { updates.push('fact_type = ?'); params.push(req.body.factType); }
    if (req.body.confidence !== undefined) { updates.push('confidence = ?'); params.push(req.body.confidence); }
    if (updates.length === 0) return res.json({ success: true });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.factId);
    const result = db.prepare(`UPDATE memory_facts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Fact not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /review/api/facts/item/:factId — Remove a fact
 */
router.delete('/api/facts/item/:factId', (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM memory_facts WHERE id = ?').run(req.params.factId);
    if (result.changes === 0) return res.status(404).json({ error: 'Fact not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /review/api/tasks/:reviewQueueId — Add a new task
 * Body: { title, description?, priority?, dueDate? }
 */
router.post('/api/tasks/:reviewQueueId', (req, res) => {
  try {
    const db = getDb();
    const { title, description, priority, dueDate } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO tasks_extracted (id, interaction_id, title, description, priority, due_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, req.params.reviewQueueId, title, description || null, priority || 'normal', dueDate || null);
    log.info({ id, reviewQueueId: req.params.reviewQueueId }, 'Task added');
    res.json({ id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /review/api/tasks/item/:taskId — Edit a task
 */
router.put('/api/tasks/item/:taskId', (req, res) => {
  try {
    const db = getDb();
    const updates = [];
    const params = [];
    if (req.body.title !== undefined) { updates.push('title = ?'); params.push(req.body.title); }
    if (req.body.description !== undefined) { updates.push('description = ?'); params.push(req.body.description); }
    if (req.body.priority !== undefined) { updates.push('priority = ?'); params.push(req.body.priority); }
    if (req.body.status !== undefined) { updates.push('status = ?'); params.push(req.body.status); }
    if (req.body.dueDate !== undefined) { updates.push('due_date = ?'); params.push(req.body.dueDate); }
    if (updates.length === 0) return res.json({ success: true });
    updates.push("updated_at = datetime('now')");
    params.push(req.params.taskId);
    const result = db.prepare(`UPDATE tasks_extracted SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /review/api/tasks/item/:taskId — Remove a task
 */
router.delete('/api/tasks/item/:taskId', (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM tasks_extracted WHERE id = ?').run(req.params.taskId);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
