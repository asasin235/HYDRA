import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';

const PI_SMB_PATH = process.env.PI_SMB_PATH || './brain';
const LANCEDB_PATH = path.join(PI_SMB_PATH, 'lancedb');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536; // text-embedding-3-small dimension

let db = null;
let memoriesTable = null;
let dailyLogsTable = null;
let reflectionsTable = null;

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
    
    let search = memoriesTable.search(queryEmbedding).limit(limit * 2);
    
    const results = await search.toArray();
    
    // Filter by agent if specified
    let filtered = agent 
      ? results.filter(r => r.agent === agent)
      : results;
    
    return filtered.slice(0, limit).map(r => ({
      id: r.id,
      agent: r.agent,
      content: r.content,
      timestamp: r.timestamp,
      score: r._distance
    }));
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
    let search = dailyLogsTable.search(queryEmbedding).limit(limit * 2);
    
    const results = await search.toArray();
    
    let filtered = agent 
      ? results.filter(r => r.agent === agent)
      : results;
    
    return filtered.slice(0, limit).map(r => ({
      id: r.id,
      agent: r.agent,
      date: r.date,
      summary: r.summary,
      score: r._distance
    }));
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
    let search = reflectionsTable.search(queryEmbedding).limit(limit * 2);
    
    const results = await search.toArray();
    
    return results
      .filter(r => r.agent === agent)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        agent: r.agent,
        week: r.week,
        score: r.score,
        changes: JSON.parse(r.changes_json || '{}')
      }));
  } catch (error) {
    console.error('[memory] getReflections failed:', error.message);
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
  }
}
