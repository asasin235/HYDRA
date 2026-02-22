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

  CREATE INDEX IF NOT EXISTS idx_agent_state_agent ON agent_state(agent);
  CREATE INDEX IF NOT EXISTS idx_daily_logs_agent_date ON daily_logs(agent, date);
  CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
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
 * Close database connection (for cleanup)
 */
export function closeDb() {
  db.close();
}

export { db };
