#!/usr/bin/env node
/**
 * scripts/ruv-migrate.js — One-shot LanceDB → RuVector migration
 *
 * Reads all rows from every LanceDB table and bulk-inserts them into RuVector.
 * Safe to re-run (RuVector upserts by composite ID so duplicates are overwritten).
 *
 * Usage: node scripts/ruv-migrate.js
 */

import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const BRAIN_BASE = process.env.BRAIN_PATH || './brain';
const LANCEDB_PATH = path.join(BRAIN_BASE, 'lancedb');

// Import after dotenv so env vars are set
const { initRuVector, batchUpsert, isAvailable } = await import('../core/ruvectorStore.js');

async function migrate() {
  console.log('[ruv-migrate] Starting LanceDB → RuVector migration...');
  console.log('[ruv-migrate] LanceDB path:', LANCEDB_PATH);

  // Init RuVector
  const db_ruv = await initRuVector();
  if (!isAvailable()) {
    console.error('[ruv-migrate] RuVector init failed — aborting.');
    process.exit(1);
  }
  console.log('[ruv-migrate] RuVector initialized ✓');

  // Connect to LanceDB
  const db = await lancedb.connect(LANCEDB_PATH);
  const tables = await db.tableNames();
  console.log('[ruv-migrate] LanceDB tables:', tables);

  let totalInserted = 0;
  let totalFailed = 0;

  for (const tableName of tables) {
    const tbl = await db.openTable(tableName);
    const allRows = await tbl.query().limit(1_000_000).toArray();

    // Skip init placeholder row
    const rows = allRows.filter(r => r.id !== 'init');

    if (rows.length === 0) {
      console.log(`[ruv-migrate] ${tableName}: 0 rows (skipped)`);
      continue;
    }

    console.log(`[ruv-migrate] ${tableName}: migrating ${rows.length} rows...`);

    // Build RuVector records
    const records = rows.map(row => {
      const { id, vector, ...rest } = row;
      // Build metadata from all non-vector fields
      const metadata = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== null && v !== undefined) {
          metadata[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }
      return {
        id: id || `${tableName}-${Date.now()}-${Math.random()}`,
        vector: vector instanceof Float32Array ? vector : new Float32Array(vector || []),
        metadata
      };
    });

    const { inserted, failed } = await batchUpsert(tableName, records);
    console.log(`[ruv-migrate] ${tableName}: ${inserted} inserted, ${failed} failed`);
    totalInserted += inserted;
    totalFailed += failed;
  }

  console.log(`\n[ruv-migrate] ✅ Migration complete: ${totalInserted} total inserted, ${totalFailed} failed`);
  if (totalFailed > 0) {
    console.warn('[ruv-migrate] Some records failed — check brain/ruvector/retry-queue.jsonl');
  }
}

migrate().catch(err => {
  console.error('[ruv-migrate] Fatal error:', err);
  process.exit(1);
});
