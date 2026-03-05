import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';

const BRAIN_BASE = process.env.BRAIN_PATH || './brain';
const LANCEDB_PATH = path.join(BRAIN_BASE, 'lancedb');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536; // text-embedding-3-small dimension

// ── RuVector env flags (all default off) ─────────────────────────────────────
const RUV_ENABLE         = process.env.RUVECTOR_ENABLE === '1';
const RUV_DUAL_WRITE     = process.env.RUVECTOR_DUAL_WRITE === '1';
const RUV_SHADOW_READ    = process.env.RUVECTOR_SHADOW_READ === '1';
const RUV_READ_PRIMARY   = process.env.RUVECTOR_READ_PRIMARY === '1';
const RUV_METRICS_PATH   = process.env.RUVECTOR_METRICS_PATH || path.join(BRAIN_BASE, 'ruvector', 'metrics.jsonl');
const RUV_TOPK_MULT      = parseInt(process.env.RUVECTOR_SHADOW_TOPK_MULTIPLIER || '3', 10);

let db = null;
let memoriesTable = null;
let dailyLogsTable = null;
let reflectionsTable = null;
let screenActivityTable = null;
let audioTranscriptsTable = null;
let contextFeedTable = null;

// RuVector module ref (lazy-loaded)
let ruv = null;

/**
 * Get embedding from OpenRouter using text-embedding-3-small
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function getEmbedding(text) {
  if (!OPENROUTER_API_KEY) {
    console.error('[memory] OPENROUTER_API_KEY not set, using zero vector');
    return new Array(EMBEDDING_DIM).fill(0);
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hydra.local',
        'X-Title': 'HYDRA'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000) // Truncate to avoid token limits
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[memory] Embedding API error:', error);
      return new Array(EMBEDDING_DIM).fill(0);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('[memory] Failed to get embedding:', error.message);
    return new Array(EMBEDDING_DIM).fill(0);
  }
}

// ── RuVector helpers ─────────────────────────────────────────────────────────

/**
 * Lazily load and init RuVector if enabled.
 * Safe — never throws, never blocks LanceDB.
 */
async function ensureRuVector() {
  if (!RUV_ENABLE || ruv) return;
  try {
    ruv = await import('./ruvectorStore.js');
    await ruv.initRuVector();
    if (!ruv.isAvailable()) {
      console.warn('[memory] RuVector loaded but unavailable, disabling.');
      ruv = null;
    } else {
      console.log('[memory] RuVector integration active');
    }
  } catch (err) {
    console.error('[memory] RuVector import failed (continuing without):', err.message);
    ruv = null;
  }
}

/**
 * Fire-and-forget dual-write to RuVector. Never blocks or throws.
 */
function dualWrite(tableName, record) {
  if (!RUV_ENABLE || !RUV_DUAL_WRITE || !ruv || !ruv.isAvailable()) return;
  // Intentionally not awaited — fire-and-forget
  ruv.upsert(tableName, record).catch(err => {
    console.error(`[memory] RuVector dual-write failed for ${tableName}:`, err.message);
  });
}

/**
 * Perform shadow read on RuVector and record metrics.
 * Returns RuVector results if RUV_READ_PRIMARY is set; otherwise returns null.
 * @param {string} funcName - Name of the calling search function
 * @param {string} tableName - Logical table to search
 * @param {number[]} queryEmbedding - Query vector
 * @param {object} opts - Search options (limit, agent, source_type, since)
 * @param {number} lanceDurationMs - LanceDB search latency
 * @param {Array} lanceResults - LanceDB results (with id field)
 * @returns {Promise<Array|null>} RuVector results if primary, or null
 */
async function shadowRead(funcName, tableName, queryEmbedding, opts, lanceDurationMs, lanceResults) {
  if (!RUV_ENABLE || (!RUV_SHADOW_READ && !RUV_READ_PRIMARY) || !ruv || !ruv.isAvailable()) {
    return null;
  }

  let ruvResults = [];
  let ruvMs = 0;
  let ruvError = null;

  try {
    const ruvStart = performance.now();
    ruvResults = await ruv.search(tableName, queryEmbedding, opts);
    ruvMs = Math.round((performance.now() - ruvStart) * 100) / 100;
  } catch (err) {
    ruvError = err.message;
    console.error(`[memory] RuVector shadow read failed in ${funcName}:`, err.message);
  }

  // Compute overlap
  const lanceIds = lanceResults.map(r => r.id).slice(0, opts.limit || 5);
  const ruvIds = ruvResults.map(r => r.id).slice(0, opts.limit || 5);
  const overlap = lanceIds.filter(id => ruvIds.includes(id)).length;
  const overlapRatio = lanceIds.length > 0 ? Math.round((overlap / lanceIds.length) * 100) / 100 : 0;

  // Write metrics line
  const metricsLine = {
    ts: new Date().toISOString(),
    fn: funcName,
    table: tableName,
    limit: opts.limit || 5,
    filters: { agent: opts.agent, source_type: opts.source_type, since: opts.since },
    lance_ms: lanceDurationMs,
    ruv_ms: ruvMs,
    lance_ids: lanceIds,
    ruv_ids: ruvIds,
    overlap_ratio: overlapRatio,
    lance_backend: 'distance (lower=better)',
    ruv_backend: 'score (higher=better)',
    error: ruvError
  };

  ruv.writeJsonlLine(RUV_METRICS_PATH, metricsLine).catch(() => {});

  // If read-primary, return RuVector results
  if (RUV_READ_PRIMARY && !ruvError) {
    return ruvResults;
  }

  return null;
}

/**
 * Initialize LanceDB connection and tables
 */
async function initDb() {
  if (db) return;

  await fs.ensureDir(LANCEDB_PATH);
  db = await lancedb.connect(LANCEDB_PATH);

  // Create memories table if not exists
  const tables = await db.tableNames();

  if (!tables.includes('memories')) {
    memoriesTable = await db.createTable('memories', [
      {
        id: 'init',
        agent: 'system',
        content: 'Memory system initialized',
        timestamp: new Date().toISOString(),
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    memoriesTable = await db.openTable('memories');
  }

  if (!tables.includes('daily_logs')) {
    dailyLogsTable = await db.createTable('daily_logs', [
      {
        id: 'init',
        agent: 'system',
        date: new Date().toISOString().split('T')[0],
        summary: 'Daily logs initialized',
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    dailyLogsTable = await db.openTable('daily_logs');
  }

  // ── Screen Activity table ──────────────────────────────────────────
  if (!tables.includes('screen_activity')) {
    screenActivityTable = await db.createTable('screen_activity', [
      {
        id: 'init',
        source: 'system',
        timestamp: new Date().toISOString(),
        apps: '',
        summary: 'Screen activity tracking initialized',
        raw_text: '',
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    screenActivityTable = await db.openTable('screen_activity');
  }

  // ── Audio Transcripts table ─────────────────────────────────────────
  if (!tables.includes('audio_transcripts')) {
    audioTranscriptsTable = await db.createTable('audio_transcripts', [
      {
        id: 'init',
        source: 'system',
        timestamp: new Date().toISOString(),
        filename: '',
        transcript: 'Audio transcript tracking initialized',
        summary: '',
        duration_s: 0,
        tags: '',
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    audioTranscriptsTable = await db.openTable('audio_transcripts');
  }

  // ── Context Feed table (unified cross-source search) ────────────────
  if (!tables.includes('context_feed')) {
    contextFeedTable = await db.createTable('context_feed', [
      {
        id: 'init',
        source_type: 'system',
        source: 'system',
        timestamp: new Date().toISOString(),
        content: 'Context feed initialized',
        metadata_json: '{}',
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    contextFeedTable = await db.openTable('context_feed');
  }

    if (!tables.includes('reflections')) {
    reflectionsTable = await db.createTable('reflections', [
      {
        id: 'init',
        agent: 'system',
        week: '2024-W01',
        score: 0,
        changes_json: '{}',
        vector: new Array(EMBEDDING_DIM).fill(0)
      }
    ]);
  } else {
    reflectionsTable = await db.openTable('reflections');
  }

  // Initialize RuVector if enabled
  await ensureRuVector();
}

/**
 * Add a memory with vector embedding
 * @param {string} agent - Agent name
 * @param {string} content - Memory content
 * @returns {Promise<string>} Memory ID
 */
export async function addMemory(agent, content) {
  try {
    await initDb();

    const id = uuidv4();
    const embedding = await getEmbedding(content);

    await memoriesTable.add([{
      id,
      agent,
      content,
      timestamp: new Date().toISOString(),
      vector: embedding
    }]);

    // Dual-write to RuVector
    dualWrite('memories', {
      id,
      vector: embedding,
      metadata: { agent, content, timestamp: new Date().toISOString() }
    });

    return id;
  } catch (error) {
    console.error('[memory] addMemory failed:', error.message);
    throw error;
  }
}

/**
 * Search memories using vector similarity
 * @param {string} agent - Agent name (or null for all agents)
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Matching memories
 */
export async function searchMemory(agent, query, limit = 5) {
  try {
    await initDb();

    const queryEmbedding = await getEmbedding(query);

    const lanceStart = performance.now();
    let search = memoriesTable.search(queryEmbedding).limit(limit * 2);
    const results = await search.toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    // Filter by agent if specified
    let filtered = agent
      ? results.filter(r => r.agent === agent)
      : results;

    const lanceResults = filtered.slice(0, limit).map(r => ({
      id: r.id,
      agent: r.agent,
      content: r.content,
      timestamp: r.timestamp,
      score: r._distance
    }));

    // Shadow read
    const ruvResults = await shadowRead('searchMemory', 'memories', queryEmbedding,
      { limit, agent }, lanceDurationMs, lanceResults);

    if (ruvResults) {
      return ruvResults.map(r => ({
        id: r.id,
        agent: r.metadata?.agent || '',
        content: r.metadata?.content || '',
        timestamp: r.metadata?.timestamp || '',
        score: r.score
      }));
    }

    return lanceResults;
  } catch (error) {
    console.error('[memory] searchMemory failed:', error.message);
    return [];
  }
}

/**
 * Add a daily log with vector embedding
 * @param {string} agent - Agent name
 * @param {string} date - Date (YYYY-MM-DD)
 * @param {string} summary - Log summary
 * @returns {Promise<string>} Log ID
 */
export async function addLog(agent, date, summary) {
  try {
    await initDb();

    const id = uuidv4();
    const embedding = await getEmbedding(summary);

    await dailyLogsTable.add([{
      id,
      agent,
      date,
      summary,
      vector: embedding
    }]);

    // Dual-write to RuVector
    dualWrite('daily_logs', {
      id,
      vector: embedding,
      metadata: { agent, date, summary }
    });

    return id;
  } catch (error) {
    console.error('[memory] addLog failed:', error.message);
    throw error;
  }
}

/**
 * Search daily logs
 * @param {string} agent - Agent name
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Matching logs
 */
export async function searchLogs(agent, query, limit = 5) {
  try {
    await initDb();

    const queryEmbedding = await getEmbedding(query);

    const lanceStart = performance.now();
    let search = dailyLogsTable.search(queryEmbedding).limit(limit * 2);
    const results = await search.toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    let filtered = agent
      ? results.filter(r => r.agent === agent)
      : results;

    const lanceResults = filtered.slice(0, limit).map(r => ({
      id: r.id,
      agent: r.agent,
      date: r.date,
      summary: r.summary,
      score: r._distance
    }));

    // Shadow read
    const ruvResults = await shadowRead('searchLogs', 'daily_logs', queryEmbedding,
      { limit, agent }, lanceDurationMs, lanceResults);

    if (ruvResults) {
      return ruvResults.map(r => ({
        id: r.id,
        agent: r.metadata?.agent || '',
        date: r.metadata?.date || '',
        summary: r.metadata?.summary || r.metadata?.content || '',
        score: r.score
      }));
    }

    return lanceResults;
  } catch (error) {
    console.error('[memory] searchLogs failed:', error.message);
    return [];
  }
}

/**
 * Add a weekly reflection
 * @param {string} agent - Agent name
 * @param {string} week - Week identifier (e.g., '2024-W52')
 * @param {object} data - Reflection data {score, changes, ...}
 * @returns {Promise<string>} Reflection ID
 */
export async function addReflection(agent, week, data) {
  try {
    await initDb();

    const id = uuidv4();
    const content = `Week ${week}: Score ${data.score || 0}. ${JSON.stringify(data.changes || {})}`;
    const embedding = await getEmbedding(content);

    await reflectionsTable.add([{
      id,
      agent,
      week,
      score: data.score || 0,
      changes_json: JSON.stringify(data.changes || {}),
      vector: embedding
    }]);

    // Dual-write to RuVector
    dualWrite('reflections', {
      id,
      vector: embedding,
      metadata: { agent, week, score: String(data.score || 0), changes_json: JSON.stringify(data.changes || {}), content }
    });

    return id;
  } catch (error) {
    console.error('[memory] addReflection failed:', error.message);
    throw error;
  }
}

/**
 * Get reflections for an agent
 * @param {string} agent - Agent name
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Reflections
 */
export async function getReflections(agent, limit = 10) {
  try {
    await initDb();

    // Use a generic query embedding for recent reflections
    const queryEmbedding = await getEmbedding(`${agent} weekly reflection performance`);

    const lanceStart = performance.now();
    let search = reflectionsTable.search(queryEmbedding).limit(limit * 2);
    const results = await search.toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    const lanceResults = results
      .filter(r => r.agent === agent)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        agent: r.agent,
        week: r.week,
        score: r.score,
        changes: JSON.parse(r.changes_json || '{}')
      }));

    // Shadow read (for metrics only — reflections have a different output shape)
    await shadowRead('getReflections', 'reflections', queryEmbedding,
      { limit, agent }, lanceDurationMs, lanceResults);

    return lanceResults;
  } catch (error) {
    console.error('[memory] getReflections failed:', error.message);
    return [];
  }
}

// ── Screen Activity ────────────────────────────────────────────────────

/**
 * Add a screen activity entry with vector embedding
 * @param {Object} entry
 * @param {string} entry.source - Device name (e.g. 'macbook-pro')
 * @param {string} entry.timestamp - ISO timestamp
 * @param {string[]} entry.apps - Active apps
 * @param {string} entry.summary - LLM-generated summary
 * @param {string} [entry.raw_text] - Raw OCR text (optional)
 * @returns {Promise<string>} Entry ID
 */
export async function addScreenActivity({ source, timestamp, apps = [], summary, raw_text = '' }) {
  try {
    await initDb();
    const id = uuidv4();
    const textForEmbed = `[${apps.join(', ')}] ${summary}`;
    const embedding = await getEmbedding(textForEmbed);

    await screenActivityTable.add([{
      id,
      source,
      timestamp: timestamp || new Date().toISOString(),
      apps: apps.join(', '),
      summary,
      raw_text: raw_text.slice(0, 4000),
      vector: embedding
    }]);

    // Also add to unified context_feed
    const ctxId = uuidv4();
    await contextFeedTable.add([{
      id: ctxId,
      source_type: 'screen',
      source,
      timestamp: timestamp || new Date().toISOString(),
      content: textForEmbed,
      metadata_json: JSON.stringify({ apps, has_raw: !!raw_text }),
      vector: embedding
    }]);

    // Dual-write both to RuVector
    dualWrite('screen_activity', {
      id,
      vector: embedding,
      metadata: {
        source,
        timestamp: timestamp || new Date().toISOString(),
        apps: apps.join(', '),
        summary,
        content: textForEmbed
      }
    });
    dualWrite('context_feed', {
      id: ctxId,
      vector: embedding,
      metadata: {
        source_type: 'screen',
        source,
        timestamp: timestamp || new Date().toISOString(),
        content: textForEmbed,
        metadata_json: JSON.stringify({ apps, has_raw: !!raw_text }),
        parent_id: id
      }
    });

    return id;
  } catch (error) {
    console.error('[memory] addScreenActivity failed:', error.message);
    throw error;
  }
}

/**
 * Search screen activity using semantic similarity
 * @param {string} query - Natural language query (e.g. "finances budget")
 * @param {Object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.since] - ISO timestamp to filter from
 * @returns {Promise<Array>} Matching screen entries
 */
export async function searchScreenContext(query, { limit = 5, since } = {}) {
  try {
    await initDb();
    const queryEmbedding = await getEmbedding(query);

    const lanceStart = performance.now();
    const results = await screenActivityTable.search(queryEmbedding).limit(limit * 2).toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    let filtered = results;
    if (since) {
      filtered = filtered.filter(r => r.timestamp >= since);
    }

    const lanceResults = filtered.slice(0, limit).map(r => ({
      id: r.id,
      source: r.source,
      timestamp: r.timestamp,
      apps: r.apps,
      summary: r.summary,
      score: r._distance
    }));

    // Shadow read
    const ruvResults = await shadowRead('searchScreenContext', 'screen_activity', queryEmbedding,
      { limit, since }, lanceDurationMs, lanceResults);

    if (ruvResults) {
      return ruvResults.map(r => ({
        id: r.id,
        source: r.metadata?.source || '',
        timestamp: r.metadata?.timestamp || '',
        apps: r.metadata?.apps || '',
        summary: r.metadata?.summary || r.metadata?.content || '',
        score: r.score
      }));
    }

    return lanceResults;
  } catch (error) {
    console.error('[memory] searchScreenContext failed:', error.message);
    return [];
  }
}

// ── Audio Transcripts ─────────────────────────────────────────────────

/**
 * Add an audio transcript entry with vector embedding
 * @param {Object} entry
 * @param {string} entry.source - Source (e.g. 'plaud-note', 'screenpipe-audio')
 * @param {string} entry.timestamp - ISO timestamp
 * @param {string} entry.filename - Original audio filename
 * @param {string} entry.transcript - Full transcript text
 * @param {string} entry.summary - LLM-generated summary
 * @param {number} [entry.duration_s] - Duration in seconds
 * @param {string[]} [entry.tags] - Topic tags
 * @returns {Promise<string>} Entry ID
 */
export async function addAudioTranscript({ source, timestamp, filename, transcript, summary, duration_s = 0, tags = [] }) {
  try {
    await initDb();
    const id = uuidv4();
    const textForEmbed = `${summary} ${tags.join(' ')}`;
    const embedding = await getEmbedding(textForEmbed);

    await audioTranscriptsTable.add([{
      id,
      source,
      timestamp: timestamp || new Date().toISOString(),
      filename: filename || '',
      transcript: transcript.slice(0, 8000),
      summary,
      duration_s,
      tags: tags.join(', '),
      vector: embedding
    }]);

    // Also add to unified context_feed
    const ctxId = uuidv4();
    await contextFeedTable.add([{
      id: ctxId,
      source_type: 'audio',
      source,
      timestamp: timestamp || new Date().toISOString(),
      content: textForEmbed,
      metadata_json: JSON.stringify({ filename, duration_s, tags }),
      vector: embedding
    }]);

    // Dual-write both to RuVector
    dualWrite('audio_transcripts', {
      id,
      vector: embedding,
      metadata: {
        source,
        timestamp: timestamp || new Date().toISOString(),
        filename: filename || '',
        summary,
        duration_s: String(duration_s),
        tags: tags.join(', '),
        content: textForEmbed
      }
    });
    dualWrite('context_feed', {
      id: ctxId,
      vector: embedding,
      metadata: {
        source_type: 'audio',
        source,
        timestamp: timestamp || new Date().toISOString(),
        content: textForEmbed,
        metadata_json: JSON.stringify({ filename, duration_s, tags }),
        parent_id: id
      }
    });

    return id;
  } catch (error) {
    console.error('[memory] addAudioTranscript failed:', error.message);
    throw error;
  }
}

/**
 * Search audio transcripts using semantic similarity
 * @param {string} query - Natural language query
 * @param {Object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.since] - ISO timestamp to filter from
 * @returns {Promise<Array>} Matching audio entries
 */
export async function searchAudioContext(query, { limit = 5, since } = {}) {
  try {
    await initDb();
    const queryEmbedding = await getEmbedding(query);

    const lanceStart = performance.now();
    const results = await audioTranscriptsTable.search(queryEmbedding).limit(limit * 2).toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    let filtered = results;
    if (since) {
      filtered = filtered.filter(r => r.timestamp >= since);
    }

    const lanceResults = filtered.slice(0, limit).map(r => ({
      id: r.id,
      source: r.source,
      timestamp: r.timestamp,
      filename: r.filename,
      summary: r.summary,
      duration_s: r.duration_s,
      tags: r.tags,
      score: r._distance
    }));

    // Shadow read
    const ruvResults = await shadowRead('searchAudioContext', 'audio_transcripts', queryEmbedding,
      { limit, since }, lanceDurationMs, lanceResults);

    if (ruvResults) {
      return ruvResults.map(r => ({
        id: r.id,
        source: r.metadata?.source || '',
        timestamp: r.metadata?.timestamp || '',
        filename: r.metadata?.filename || '',
        summary: r.metadata?.summary || r.metadata?.content || '',
        duration_s: parseFloat(r.metadata?.duration_s || '0'),
        tags: r.metadata?.tags || '',
        score: r.score
      }));
    }

    return lanceResults;
  } catch (error) {
    console.error('[memory] searchAudioContext failed:', error.message);
    return [];
  }
}

// ── Unified Context Search ────────────────────────────────────────────

/**
 * Search all context sources (screen, audio, memories) in one query
 * @param {string} query - Natural language query
 * @param {Object} [opts]
 * @param {number} [opts.limit=10] - Max results
 * @param {string} [opts.source_type] - Filter: 'screen', 'audio', or null for all
 * @param {string} [opts.since] - ISO timestamp to filter from
 * @returns {Promise<Array>} Matching context entries across all sources
 */
export async function searchAllContext(query, { limit = 10, source_type, since } = {}) {
  try {
    await initDb();
    const queryEmbedding = await getEmbedding(query);

    const lanceStart = performance.now();
    const results = await contextFeedTable.search(queryEmbedding).limit(limit * 3).toArray();
    const lanceDurationMs = Math.round((performance.now() - lanceStart) * 100) / 100;

    let filtered = results;
    if (source_type) {
      filtered = filtered.filter(r => r.source_type === source_type);
    }
    if (since) {
      filtered = filtered.filter(r => r.timestamp >= since);
    }

    const lanceResults = filtered.slice(0, limit).map(r => ({
      id: r.id,
      source_type: r.source_type,
      source: r.source,
      timestamp: r.timestamp,
      content: r.content,
      metadata: JSON.parse(r.metadata_json || '{}'),
      score: r._distance
    }));

    // Shadow read
    const ruvResults = await shadowRead('searchAllContext', 'context_feed', queryEmbedding,
      { limit, source_type, since }, lanceDurationMs, lanceResults);

    if (ruvResults) {
      return ruvResults.map(r => ({
        id: r.id,
        source_type: r.metadata?.source_type || '',
        source: r.metadata?.source || '',
        timestamp: r.metadata?.timestamp || '',
        content: r.metadata?.content || '',
        metadata: r.metadata?.metadata_json ? JSON.parse(r.metadata.metadata_json) : {},
        score: r.score
      }));
    }

    return lanceResults;
  } catch (error) {
    console.error('[memory] searchAllContext failed:', error.message);
    return [];
  }
}

/**
 * Close the database connection
 */
export async function closeMemory() {
  if (db) {
    db = null;
    memoriesTable = null;
    dailyLogsTable = null;
    reflectionsTable = null;
    screenActivityTable = null;
    audioTranscriptsTable = null;
    contextFeedTable = null;
  }
  if (ruv) {
    try { ruv.closeRuVector(); } catch { /* ignore */ }
    ruv = null;
  }
}
