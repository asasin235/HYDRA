/**
 * Transcript Store — preserves raw transcript (evidence) and normalized summary (interpretation) separately.
 * Core principle: Raw transcript is immutable evidence. Summary is interpretation.
 * @module core/transcript-store
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('transcript-store');

export function ensureTranscriptTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      review_queue_id TEXT NOT NULL,
      raw_transcript TEXT NOT NULL,
      normalized_summary TEXT,
      language TEXT DEFAULT 'unknown',
      source_file TEXT,
      duration_seconds REAL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (review_queue_id) REFERENCES audio_review_queue(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transcripts_review_queue ON transcripts(review_queue_id);
  `);
  log.info('Transcript tables ensured');
}

/**
 * Store raw transcript as immutable evidence.
 */
export function storeRawTranscript({ reviewQueueId, rawTranscript, language, sourceFile, durationSeconds }) {
  const db = getDb();
  const id = uuidv4();
  const wordCount = rawTranscript ? rawTranscript.split(/\s+/).filter(Boolean).length : 0;

  const stmt = db.prepare(`
    INSERT INTO transcripts (id, review_queue_id, raw_transcript, language, source_file, duration_seconds, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, reviewQueueId, rawTranscript, language || 'unknown', sourceFile || null, durationSeconds || null, wordCount);
  log.info({ id, reviewQueueId }, 'Raw transcript stored');
  return id;
}

/**
 * Store normalized summary separately (does not overwrite raw transcript).
 */
export function storeNormalizedSummary(transcriptId, normalizedSummary) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE transcripts SET normalized_summary = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const result = stmt.run(normalizedSummary, transcriptId);
  if (result.changes === 0) {
    log.warn({ transcriptId }, 'Transcript not found for summary update');
    return false;
  }
  log.info({ transcriptId }, 'Normalized summary stored');
  return true;
}

/**
 * Get full transcript record by ID.
 */
export function getTranscript(transcriptId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM transcripts WHERE id = ?');
  return stmt.get(transcriptId) || null;
}

/**
 * Get transcript by review queue ID (latest).
 */
export function getTranscriptByReviewQueueId(reviewQueueId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM transcripts WHERE review_queue_id = ? ORDER BY created_at DESC LIMIT 1');
  return stmt.get(reviewQueueId) || null;
}

/**
 * Get raw transcript only — the evidence layer.
 */
export function getRawTranscript(transcriptId) {
  const db = getDb();
  const stmt = db.prepare(
    'SELECT id, review_queue_id, raw_transcript, language, source_file, duration_seconds, word_count, created_at FROM transcripts WHERE id = ?'
  );
  return stmt.get(transcriptId) || null;
}

/**
 * Get normalized summary only — the interpretation layer.
 */
export function getNormalizedSummary(transcriptId) {
  const db = getDb();
  const stmt = db.prepare(
    'SELECT id, review_queue_id, normalized_summary, updated_at FROM transcripts WHERE id = ?'
  );
  return stmt.get(transcriptId) || null;
}

/**
 * List transcripts for a set of review queue IDs.
 */
export function listTranscriptsByReviewIds(reviewQueueIds) {
  if (!reviewQueueIds || reviewQueueIds.length === 0) return [];
  const db = getDb();
  const placeholders = reviewQueueIds.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT * FROM transcripts WHERE review_queue_id IN (${placeholders}) ORDER BY created_at DESC`
  );
  return stmt.all(...reviewQueueIds);
}

ensureTranscriptTables();
