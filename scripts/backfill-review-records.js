/**
 * Backfill Script — imports old audio memory entries into the new
 * reviewed interaction schema.
 *
 * - Preserves 'unknown' for any unset values
 * - Dry-run mode available (--dry-run flag)
 * - Safe to run multiple times (idempotent by source id check)
 *
 * Usage:
 *   node scripts/backfill-review-records.js
 *   node scripts/backfill-review-records.js --dry-run
 *   node scripts/backfill-review-records.js --limit 100
 *
 * @module scripts/backfill-review-records
 */
import { getDb } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { v4 as uuid } from 'uuid';

const log = createLogger('backfill');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx >= 0 ? parseInt(args[idx + 1]) || 500 : 500;
})();

async function main() {
  log.info({ dryRun: DRY_RUN, limit: LIMIT }, 'Starting backfill');

  const db = getDb();

  // Find old audio_memory entries not yet backfilled
  let oldEntries = [];
  try {
    oldEntries = db.prepare(`
      SELECT * FROM audio_memory
      WHERE id NOT IN (
        SELECT source_id FROM audio_review_queue WHERE source_id IS NOT NULL
      )
      ORDER BY created_at ASC
      LIMIT ?
    `).all(LIMIT);
  } catch (err) {
    // Table may not exist in all environments
    log.warn({ error: err.message }, 'audio_memory table not found or empty — nothing to backfill');
    process.exit(0);
  }

  log.info({ count: oldEntries.length }, `Found ${oldEntries.length} entries to backfill`);

  if (oldEntries.length === 0) {
    log.info('No entries to backfill. Exiting.');
    process.exit(0);
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of oldEntries) {
    try {
      // Check idempotency
      const existing = db.prepare(
        'SELECT id FROM audio_review_queue WHERE source_id = ?'
      ).get(entry.id);

      if (existing) {
        log.debug({ sourceId: entry.id }, 'Already backfilled, skipping');
        skipped++;
        continue;
      }

      if (!DRY_RUN) {
        const reviewId = uuid();
        db.prepare(`
          INSERT INTO audio_review_queue (
            id, source_id, source, status, summary, language,
            sensitivity, retention_class, domain, relationship_type,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          reviewId,
          entry.id,
          entry.source || 'plaud-note',
          'approved',                            // already in memory = treat as approved
          entry.summary || entry.content || '',
          entry.language || 'unknown',
          entry.sensitivity || 'low',
          entry.retention_class || 'context',
          entry.domain || 'unknown',
          entry.relationship_type || 'unknown',
          entry.created_at || new Date().toISOString(),
          new Date().toISOString()
        );
        log.debug({ reviewId, sourceId: entry.id }, 'Backfilled entry');
      } else {
        log.info({ sourceId: entry.id, summary: (entry.summary || '').slice(0, 60) }, '[DRY RUN] Would backfill');
      }

      inserted++;
    } catch (err) {
      log.error({ sourceId: entry.id, error: err.message }, 'Backfill entry failed');
      errors++;
    }
  }

  log.info({ inserted, skipped, errors, dryRun: DRY_RUN }, 'Backfill complete');

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would have inserted ${inserted} entries. Run without --dry-run to apply.`);
  } else {
    console.log(`\nBackfill complete: ${inserted} inserted, ${skipped} skipped, ${errors} errors.`);
  }
}

main().catch(err => {
  log.error({ error: err.message }, 'Backfill script crashed');
  process.exit(1);
});
