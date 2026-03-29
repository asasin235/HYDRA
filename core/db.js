import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';

const BRAIN_BASE = process.env.BRAIN_PATH || './brain';
const DB_PATH = path.join(BRAIN_BASE, 'brain', 'hydra.db');

// Ensure brain directory exists
fs.ensureDirSync(path.dirname(DB_PATH));

// Initialize database with WAL mode
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_state (
    agent TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (agent, key)
  );

  CREATE TABLE IF NOT EXISTS debt_tracker (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    debt REAL DEFAULT 0,
    paid REAL DEFAULT 0,
    wedding_fund REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT,
    tokens_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    qty INTEGER NOT NULL,
    price REAL NOT NULL,
    pnl REAL DEFAULT 0,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    client TEXT,
    status TEXT DEFAULT 'new',
    budget TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id INTEGER UNIQUE,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    merchant TEXT DEFAULT '',
    card TEXT DEFAULT '',
    balance REAL,
    bank TEXT DEFAULT '',
    category TEXT DEFAULT 'other',
    raw_text TEXT,
    sender TEXT,
    timestamp TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_state_agent ON agent_state(agent);
  CREATE INDEX IF NOT EXISTS idx_daily_logs_agent_date ON daily_logs(agent, date);
  CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);

  CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conv_history_agent ON conversation_history(agent, created_at);

  CREATE TABLE IF NOT EXISTS recording_briefs (
    id TEXT PRIMARY KEY,
    external_id TEXT,
    project TEXT NOT NULL DEFAULT 'general',
    meeting_type TEXT,
    participants TEXT,
    action_items_json TEXT,
    decisions TEXT,
    key_topics TEXT,
    urgency TEXT DEFAULT 'medium',
    one_line TEXT,
    slack_ts TEXT,
    slack_channel TEXT,
    triaged_at TEXT DEFAULT (datetime('now')),
    filename TEXT,
    duration_s REAL,
    transcript_preview TEXT
  );

  CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    recording_id TEXT,
    task TEXT NOT NULL,
    owner TEXT,
    due_date TEXT,
    project TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (recording_id) REFERENCES recording_briefs(id)
  );

  CREATE INDEX IF NOT EXISTS idx_briefs_project ON recording_briefs(project);
  CREATE INDEX IF NOT EXISTS idx_briefs_triaged ON recording_briefs(triaged_at);
  CREATE INDEX IF NOT EXISTS idx_actions_status ON action_items(status);
  CREATE INDEX IF NOT EXISTS idx_actions_project ON action_items(project);
  CREATE INDEX IF NOT EXISTS idx_actions_recording ON action_items(recording_id);
`);

// Initialize debt_tracker row if not exists
const initDebt = db.prepare(`
  INSERT OR IGNORE INTO debt_tracker (id, debt, paid, wedding_fund) 
  VALUES (1, 0, 0, 0)
`);
initDebt.run();

// Prepared statements for agent_state
const setStateStmt = db.prepare(`
  INSERT INTO agent_state (agent, key, value, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(agent, key) DO UPDATE SET 
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const getStateStmt = db.prepare(`
  SELECT value FROM agent_state WHERE agent = ? AND key = ?
`);

const getAllStateStmt = db.prepare(`
  SELECT key, value FROM agent_state WHERE agent = ?
`);

// Prepared statements for debt_tracker
const getDebtStmt = db.prepare(`
  SELECT debt, paid, wedding_fund, updated_at FROM debt_tracker WHERE id = 1
`);

const updateDebtStmt = db.prepare(`
  UPDATE debt_tracker 
  SET paid = paid + ?, updated_at = datetime('now')
  WHERE id = 1
`);

const setDebtStmt = db.prepare(`
  UPDATE debt_tracker 
  SET debt = ?, paid = ?, wedding_fund = ?, updated_at = datetime('now')
  WHERE id = 1
`);

// Prepared statements for daily_logs
const addLogStmt = db.prepare(`
  INSERT INTO daily_logs (agent, date, summary, tokens_used)
  VALUES (?, ?, ?, ?)
`);

const getLogsStmt = db.prepare(`
  SELECT * FROM daily_logs 
  WHERE agent = ? AND date >= date('now', '-' || ? || ' days')
  ORDER BY date DESC
`);

const getRecentLogsStmt = db.prepare(`
  SELECT agent, date, summary, tokens_used, created_at FROM daily_logs
  ORDER BY created_at DESC
  LIMIT ?
`);

// Prepared statements for paper_trades
const addTradeStmt = db.prepare(`
  INSERT INTO paper_trades (symbol, action, qty, price, pnl, timestamp)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);

const getTradesStmt = db.prepare(`
  SELECT * FROM paper_trades ORDER BY timestamp DESC LIMIT ?
`);

// Prepared statements for leads
const addLeadStmt = db.prepare(`
  INSERT INTO leads (source, client, status, budget)
  VALUES (?, ?, ?, ?)
`);

const getLeadsStmt = db.prepare(`
  SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC
`);

const updateLeadStmt = db.prepare(`
  UPDATE leads SET status = ? WHERE id = ?
`);

// Prepared statements for transactions
const addTransactionStmt = db.prepare(`
  INSERT OR IGNORE INTO transactions (msg_id, type, amount, merchant, card, balance, bank, category, raw_text, sender, timestamp, date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getTransactionsStmt = db.prepare(`
  SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY timestamp DESC
`);

const getDailySpendStmt = db.prepare(`
  SELECT date, category, SUM(amount) as total, COUNT(*) as count
  FROM transactions WHERE type = 'debit' AND date >= ? AND date <= ?
  GROUP BY date, category ORDER BY date DESC, total DESC
`);

const getSpendByCategoryStmt = db.prepare(`
  SELECT category, SUM(amount) as total, COUNT(*) as count
  FROM transactions WHERE type = 'debit' AND date >= ? AND date <= ?
  GROUP BY category ORDER BY total DESC
`);

const getRecentTransactionsStmt = db.prepare(`
  SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?
`);

const getSyncStateStmt = db.prepare(`
  SELECT value FROM sync_state WHERE key = ?
`);

const setSyncStateStmt = db.prepare(`
  INSERT OR REPLACE INTO sync_state (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
`);

// Prepared statements for conversation_history
const addConvMsgStmt = db.prepare(`
  INSERT INTO conversation_history (agent, role, content, created_at)
  VALUES (?, ?, ?, datetime('now'))
`);

const getRecentConvStmt = db.prepare(`
  SELECT role, content FROM conversation_history
  WHERE agent = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const pruneConvStmt = db.prepare(`
  DELETE FROM conversation_history
  WHERE agent = ? AND id NOT IN (
    SELECT id FROM conversation_history WHERE agent = ? ORDER BY created_at DESC LIMIT ?
  )
`);

// Prepared statements for recording_briefs
const saveBriefStmt = db.prepare(`
  INSERT OR REPLACE INTO recording_briefs
    (id, external_id, project, meeting_type, participants, action_items_json, decisions, key_topics, urgency, one_line, slack_ts, slack_channel, triaged_at, filename, duration_s, transcript_preview)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
`);

const getBriefStmt = db.prepare(`SELECT * FROM recording_briefs WHERE id = ?`);

const listBriefsStmt = db.prepare(`
  SELECT * FROM recording_briefs
  WHERE (? IS NULL OR project = ?)
  ORDER BY triaged_at DESC LIMIT ?
`);

const listBriefsSinceStmt = db.prepare(`
  SELECT * FROM recording_briefs
  WHERE (? IS NULL OR project = ?) AND triaged_at >= ?
  ORDER BY triaged_at DESC LIMIT ?
`);

// Prepared statements for action_items
const saveActionStmt = db.prepare(`
  INSERT OR REPLACE INTO action_items (id, recording_id, task, owner, due_date, project, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const listActionsStmt = db.prepare(`
  SELECT * FROM action_items
  WHERE (? IS NULL OR project = ?) AND (? IS NULL OR status = ?)
  ORDER BY created_at DESC LIMIT ?
`);

const updateActionStmt = db.prepare(`
  UPDATE action_items SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END
  WHERE id = ?
`);

const projectSummaryStmt = db.prepare(`
  SELECT project,
    COUNT(*) as recording_count,
    MAX(triaged_at) as last_activity,
    (SELECT COUNT(*) FROM action_items ai WHERE ai.project = rb.project AND ai.status = 'open') as open_actions
  FROM recording_briefs rb
  GROUP BY project
  ORDER BY last_activity DESC
`);

/**
 * Set agent state
 * @param {string} agent - Agent name
 * @param {string} key - State key
 * @param {any} value - State value (will be JSON stringified)
 */
export function setState(agent, key, value) {
  const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
  setStateStmt.run(agent, key, jsonValue);
}

/**
 * Get agent state
 * @param {string} agent - Agent name
 * @param {string} key - State key
 * @returns {any} Parsed value or null
 */
export function getState(agent, key) {
  const row = getStateStmt.get(agent, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

/**
 * Get all state for an agent
 * @param {string} agent - Agent name
 * @returns {object} Key-value pairs
 */
export function getAllState(agent) {
  const rows = getAllStateStmt.all(agent);
  const state = {};
  for (const row of rows) {
    try {
      state[row.key] = JSON.parse(row.value);
    } catch {
      state[row.key] = row.value;
    }
  }
  return state;
}

/**
 * Get debt tracker data
 * @returns {object} {debt, paid, wedding_fund, updated_at}
 */
export function getDebt() {
  return getDebtStmt.get();
}

/**
 * Update debt by adding to paid amount
 * @param {number} paid - Amount paid
 */
export function updateDebt(paid) {
  updateDebtStmt.run(paid);
}

/**
 * Set all debt tracker values
 * @param {number} debt - Total debt
 * @param {number} paid - Total paid
 * @param {number} weddingFund - Wedding fund amount
 */
export function setDebt(debt, paid, weddingFund) {
  setDebtStmt.run(debt, paid, weddingFund);
}

/**
 * Add a daily log entry
 * @param {string} agent - Agent name
 * @param {string} date - Date (YYYY-MM-DD)
 * @param {string} summary - Log summary
 * @param {number} tokensUsed - Tokens used
 */
export function addLog(agent, date, summary, tokensUsed = 0) {
  addLogStmt.run(agent, date, summary, tokensUsed);
}

/**
 * Get logs for an agent
 * @param {string} agent - Agent name
 * @param {number} days - Number of days to look back
 * @returns {Array} Log entries
 */
export function getLogs(agent, days = 7) {
  return getLogsStmt.all(agent, days);
}

/**
 * Get recent logs across all agents
 * @param {number} limit - Max log entries to return
 * @returns {Array} Log entries sorted by most recent
 */
export function getRecentLogs(limit = 50) {
  return getRecentLogsStmt.all(limit);
}

/**
 * Add a paper trade
 * @param {string} symbol - Stock symbol
 * @param {string} action - 'buy' or 'sell'
 * @param {number} qty - Quantity
 * @param {number} price - Price per share
 * @param {number} pnl - Profit/loss
 */
export function addTrade(symbol, action, qty, price, pnl = 0) {
  addTradeStmt.run(symbol, action, qty, price, pnl);
}

/**
 * Get recent trades
 * @param {number} limit - Max number of trades
 * @returns {Array} Trade entries
 */
export function getTrades(limit = 50) {
  return getTradesStmt.all(limit);
}

/**
 * Add a lead
 * @param {string} source - Lead source
 * @param {string} client - Client name
 * @param {string} status - Lead status
 * @param {string} budget - Budget info
 * @returns {number} Lead ID
 */
export function addLead(source, client, status = 'new', budget = '') {
  const result = addLeadStmt.run(source, client, status, budget);
  return result.lastInsertRowid;
}

/**
 * Get leads by status
 * @param {string} status - Lead status
 * @returns {Array} Lead entries
 */
export function getLeads(status = 'new') {
  return getLeadsStmt.all(status);
}

/**
 * Update lead status
 * @param {number} id - Lead ID
 * @param {string} status - New status
 */
export function updateLead(id, status) {
  updateLeadStmt.run(status, id);
}

/**
 * Add a transaction from SMS
 * @param {object} tx - Transaction object
 */
export function addTransaction(tx) {
  addTransactionStmt.run(
    tx.msg_id, tx.type, tx.amount, tx.merchant || '', tx.card || '',
    tx.balance, tx.bank || '', tx.category || 'other',
    tx.raw_text || '', tx.sender || '', tx.timestamp, tx.date
  );
}

/**
 * Get transactions in a date range
 * @param {string} fromDate - Start date YYYY-MM-DD
 * @param {string} toDate - End date YYYY-MM-DD
 * @returns {Array}
 */
export function getTransactions(fromDate, toDate) {
  return getTransactionsStmt.all(fromDate, toDate);
}

/**
 * Get daily spending breakdown by category
 * @param {string} fromDate - Start date YYYY-MM-DD
 * @param {string} toDate - End date YYYY-MM-DD
 * @returns {Array} {date, category, total, count}
 */
export function getDailySpend(fromDate, toDate) {
  return getDailySpendStmt.all(fromDate, toDate);
}

/**
 * Get spending totals by category in a date range
 * @param {string} fromDate - Start date YYYY-MM-DD
 * @param {string} toDate - End date YYYY-MM-DD
 * @returns {Array} {category, total, count}
 */
export function getSpendByCategory(fromDate, toDate) {
  return getSpendByCategoryStmt.all(fromDate, toDate);
}

/**
 * Get recent transactions
 * @param {number} limit - Max results
 * @returns {Array}
 */
export function getRecentTransactions(limit = 20) {
  return getRecentTransactionsStmt.all(limit);
}

/**
 * Get last sync timestamp for a service
 * @param {string} key - Service name
 * @returns {string|null}
 */
export function getLastSyncTimestamp(key) {
  const row = getSyncStateStmt.get(key);
  return row ? row.value : null;
}

/**
 * Set last sync timestamp for a service
 * @param {string} key - Service name
 * @param {string} value - ISO timestamp
 */
export function setLastSyncTimestamp(key, value) {
  setSyncStateStmt.run(key, value);
}

/**
 * Add a conversation message for an agent
 * @param {string} agent - Agent name
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message content
 */
export function addConversationMessage(agent, role, content) {
  addConvMsgStmt.run(agent, role, content.slice(0, 4000));
}

/**
 * Get recent conversation messages for an agent (oldest-first)
 * @param {string} agent - Agent name
 * @param {number} limit - Max messages to return
 * @returns {Array<{role: string, content: string}>}
 */
export function getRecentConversation(agent, limit = 10) {
  return getRecentConvStmt.all(agent, limit).reverse();
}

/**
 * Prune old conversation messages, keeping the most recent N
 * @param {string} agent - Agent name
 * @param {number} keepLast - Number of messages to keep
 */
export function pruneConversation(agent, keepLast = 20) {
  pruneConvStmt.run(agent, agent, keepLast);
}

/**
 * Save a recording brief (triage result)
 * @param {object} brief - Recording brief object
 */
export function saveRecordingBrief(brief) {
  saveBriefStmt.run(
    brief.id, brief.external_id || null, brief.project || 'general',
    brief.meeting_type || null, JSON.stringify(brief.participants || []),
    JSON.stringify(brief.action_items || []), JSON.stringify(brief.decisions || []),
    JSON.stringify(brief.key_topics || []), brief.urgency || 'medium',
    brief.one_line || null, brief.slack_ts || null, brief.slack_channel || null,
    brief.filename || null, brief.duration_s || null,
    (brief.transcript_preview || '').slice(0, 500)
  );
}

/**
 * Get a single recording brief by ID
 * @param {string} id
 * @returns {object|null}
 */
export function getRecordingBrief(id) {
  const row = getBriefStmt.get(id);
  if (!row) return null;
  return parseBriefRow(row);
}

/**
 * List recording briefs with optional project filter
 * @param {object} opts - { project, since, limit }
 * @returns {Array}
 */
export function listRecordingBriefs({ project = null, since = null, limit = 50 } = {}) {
  const rows = since
    ? listBriefsSinceStmt.all(project, project, since, limit)
    : listBriefsStmt.all(project, project, limit);
  return rows.map(parseBriefRow);
}

/**
 * Get project summary stats
 * @returns {Array} { project, recording_count, last_activity, open_actions }
 */
export function getProjectSummary() {
  return projectSummaryStmt.all();
}

/**
 * Save an action item
 * @param {object} item - { id, recording_id, task, owner, due_date, project, status }
 */
export function saveActionItem(item) {
  saveActionStmt.run(
    item.id, item.recording_id || null, item.task,
    item.owner || null, item.due_date || null,
    item.project || 'general', item.status || 'open'
  );
}

/**
 * List action items with optional project/status filter
 * @param {object} opts - { project, status, limit }
 * @returns {Array}
 */
export function listActionItems({ project = null, status = null, limit = 100 } = {}) {
  return listActionsStmt.all(project, project, status, status, limit);
}

/**
 * Update action item status
 * @param {string} id - Action item ID
 * @param {string} status - New status: open, done, snoozed, delegated
 */
export function updateActionItem(id, status) {
  updateActionStmt.run(status, status, id);
}

function parseBriefRow(row) {
  return {
    ...row,
    participants: safeParse(row.participants),
    action_items_json: safeParse(row.action_items_json),
    decisions: safeParse(row.decisions),
    key_topics: safeParse(row.key_topics),
  };
}

function safeParse(val) {
  if (!val) return [];
  try { return JSON.parse(val); } catch { return []; }
}

/**
 * Close database connection (for cleanup)
 */
export function closeDb() {
  db.close();
}

export function getDb() {
  return db;
}

export { db };
