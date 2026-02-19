import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { addTrade, getTrades } from '../core/db.js';
import { writeBrain, readBrain } from '../core/filesystem.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#09-wolf';
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const TRADES_FILE = path.join(BRAIN_PATH, 'brain', '09_WOLF', 'paper_trades.json');
const VIRTUAL_START = 100000; // ₹1,00,000 virtual capital

const wolf = new Agent({
  name: '09-wolf',
  model: 'deepseek/deepseek-r1',
  systemPromptPath: 'prompts/09-wolf.txt',
  tools: [],
  namespace: '09_WOLF',
  tokenBudget: 500000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[09-wolf] Slack post error:', e.message);
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function marketResearch(symbol) {
  try {
    if (!PERPLEXITY_API_KEY) {
      return `Perplexity not configured; skipping research for ${symbol}`;
    }
    const res = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [{ role: 'user', content: `NSE stock ${symbol}: current price, today's news, technical trend (RSI/MACD brief), market sentiment. JSON format: {price, news_summary, trend, sentiment}` }]
    }, { headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data?.choices?.[0]?.message?.content || 'No data';
  } catch (e) {
    return `marketResearch error for ${symbol}: ${e.message}`;
  }
}

async function loadTrades() {
  try {
    const exists = await fs.pathExists(TRADES_FILE);
    return exists ? await fs.readJson(TRADES_FILE) : { portfolio: {}, trades: [], pnl: 0, capital: VIRTUAL_START };
  } catch { return { portfolio: {}, trades: [], pnl: 0, capital: VIRTUAL_START }; }
}

async function saveTrades(data) {
  await fs.ensureDir(path.dirname(TRADES_FILE));
  await fs.writeJson(TRADES_FILE, data, { spaces: 2 });
}

async function paperTrade(action, symbol, qty, price, reasoning) {
  try {
    const data = await loadTrades();
    const cost = qty * price;

    if (action === 'buy') {
      if (data.capital < cost) return 'Insufficient virtual capital';
      data.capital -= cost;
      data.portfolio[symbol] = (data.portfolio[symbol] || 0) + qty;
    } else if (action === 'sell') {
      const held = data.portfolio[symbol] || 0;
      if (held < qty) return `Cannot sell ${qty}, only holding ${held} of ${symbol}`;
      data.capital += cost;
      data.portfolio[symbol] = held - qty;
      if (data.portfolio[symbol] === 0) delete data.portfolio[symbol];

      // Calculate P&L based on average buy price from trades
      const buys = (data.trades || []).filter(t => t.symbol === symbol && t.action === 'buy');
      const avgBuy = buys.length ? buys.reduce((s, t) => s + t.price, 0) / buys.length : price;
      const tradePnl = (price - avgBuy) * qty;
      data.pnl = (data.pnl || 0) + tradePnl;
    }

    const tradeEntry = { action, symbol, qty, price, cost, reasoning, timestamp: new Date().toISOString() };
    data.trades = data.trades || [];
    data.trades.push(tradeEntry);

    await saveTrades(data);
    // Also log to SQLite
    addTrade(symbol, action, qty, price, action === 'sell' ? (data.pnl || 0) : 0);
    return `Trade executed: ${action} ${qty}x${symbol} @₹${price}. Capital: ₹${data.capital.toFixed(0)}`;
  } catch (e) {
    return `paperTrade error: ${e.message}`;
  }
}

async function portfolioSummary() {
  try {
    const data = await loadTrades();
    const trades = data.trades || [];
    const total = trades.length;
    const wins = trades.filter(t => t.action === 'sell' && (t.pnl || 0) > 0).length;
    const winRate = total > 0 ? ((wins / Math.max(trades.filter(t => t.action === 'sell').length, 1)) * 100).toFixed(1) : 0;
    const sellTrades = trades.filter(t => t.action === 'sell');
    const best = sellTrades.length ? sellTrades.reduce((a, b) => (a.pnl || 0) > (b.pnl || 0) ? a : b) : null;
    const worst = sellTrades.length ? sellTrades.reduce((a, b) => (a.pnl || 0) < (b.pnl || 0) ? a : b) : null;

    return {
      capital: data.capital,
      pnl: data.pnl || 0,
      portfolio: data.portfolio,
      total_trades: total,
      win_rate: winRate + '%',
      best_trade: best ? `${best.symbol} ₹${(best.pnl || 0).toFixed(0)}` : 'N/A',
      worst_trade: worst ? `${worst.symbol} ₹${(worst.pnl || 0).toFixed(0)}` : 'N/A'
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Cron Sessions ─────────────────────────────────────────────────────────────

// Weekdays 9:30AM and 3:30PM
async function tradingSession(session) {
  try {
    // Nifty top 5 movers (hardcoded proxies; real integration would use NSE API)
    const NIFTY_TOP5 = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'WIPRO'];
    const todayData = await loadTrades();
    const todayTrades = (todayData.trades || []).filter(t => t.timestamp?.startsWith(new Date().toISOString().split('T')[0]));

    if (todayTrades.length >= 2) {
      await postSlack(`Max 2 trades/day reached — skipping ${session} session.`);
      return;
    }

    const research = [];
    for (const sym of NIFTY_TOP5) {
      const r = await marketResearch(sym);
      research.push(`${sym}: ${r}`);
    }

    const summary = await portfolioSummary();
    const ctx = [
      `Session: ${session} | Date: ${new Date().toISOString()}`,
      `Portfolio: ${JSON.stringify(summary)}`,
      `Trades today: ${todayTrades.length}/2`,
      `Market data:\n${research.join('\n')}`
    ].join('\n');

    const decision = await wolf.run(
      'Analyze these 5 Nifty stocks. Choose at most 1 trade (buy or sell or pass). Give exact: action, symbol, qty, price, reasoning. Format: JSON {action:"buy"|"sell"|"pass", symbol, qty, price, reasoning}',
      ctx
    );

    let parsed;
    try {
      const match = decision.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch { parsed = null; }

    if (parsed && parsed.action !== 'pass' && parsed.symbol && parsed.qty && parsed.price) {
      const result = await paperTrade(parsed.action, parsed.symbol, parsed.qty, parsed.price, parsed.reasoning);
      await postSlack(`*${session} Trade*: ${result}\nReasoning: ${parsed.reasoning}`);
    } else {
      await postSlack(`*${session}*: No trade — ${decision?.slice(0, 200)}`);
    }
  } catch (e) {
    console.error('[09-wolf] trading session error:', e.message);
  }
}

// Weekdays 9:30AM
cron.schedule('30 9 * * 1-5', async () => { await tradingSession('9:30AM'); }, { timezone: process.env.TZ || 'Asia/Kolkata' });
// Weekdays 3:30PM
cron.schedule('30 15 * * 1-5', async () => { await tradingSession('3:30PM'); }, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Sunday: performance review + go-live recommendation
cron.schedule('0 10 * * 0', async () => {
  try {
    const summary = await portfolioSummary();
    const weeklyTrades = getTrades(50).filter(t => {
      const d = new Date(t.timestamp);
      return d > new Date(Date.now() - 28 * 86400000);
    });
    const weeklyWins = weeklyTrades.filter(t => t.action === 'sell' && t.pnl > 0).length;
    const weeklyWinRate = weeklyTrades.filter(t => t.action === 'sell').length > 0
      ? (weeklyWins / weeklyTrades.filter(t => t.action === 'sell').length * 100).toFixed(1)
      : 0;

    let msg = `*Weekly Performance*\nP&L: ₹${(summary.pnl || 0).toFixed(0)} | Win rate: ${summary.win_rate}\n4-week win rate: ${weeklyWinRate}%`;
    if (Number(weeklyWinRate) >= 70) {
      msg += `\n\n*@here RECOMMENDATION: Win rate ${weeklyWinRate}% over 4 weeks. Consider going LIVE.*`;
    }
    await postSlack(msg);
  } catch (e) {
    console.error('[09-wolf] Sunday review failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

export { marketResearch, paperTrade, portfolioSummary };

if (process.argv.includes('--session-now')) {
  tradingSession('manual');
}
