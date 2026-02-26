import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { getDebt, setDebt, getTransactions, getDailySpend, getSpendByCategory, getRecentTransactions } from '../core/db.js';

validateEnv('06-cfobot');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#06-cfobot';
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const CFO_MONTHLY_INCOME = Number(process.env.CFO_MONTHLY_INCOME || 0);
const CFO_MONTHLY_DEBT_PAYMENT = Number(process.env.CFO_MONTHLY_DEBT_PAYMENT || 0);

const cfo = new Agent({
  name: '06-cfobot',
  model: 'google/gemini-2.5-pro',
  systemPromptPath: 'prompts/06-cfobot.txt',
  tools: [],
  namespace: '06_CFO',
  tokenBudget: 200000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }});
  } catch (e) {
    console.error('[06-cfobot] Slack post error:', e.message);
  }
}

async function readSMSInbox() {
  try {
    const inboxFile = path.join(BRAIN_PATH, '06_CFO', 'sms_inbox.json');
    const exists = await fs.pathExists(inboxFile);
    if (!exists) return [];
    const data = await fs.readFile(inboxFile, 'utf-8');
    const arr = JSON.parse(data);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[06-cfobot] readSMSInbox error:', e.message);
    return [];
  }
}

function parseAmount(x) {
  if (typeof x === 'number' && !isNaN(x)) return x;
  if (typeof x === 'string') {
    const m = x.replace(/[,₹]/g, '').match(/(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function categorize(tx) {
  const text = (tx.text || tx.message || '').toLowerCase();
  const merchant = (tx.merchant || '').toLowerCase();
  const amt = parseAmount(tx.amount || text);
  const patterns = {
    essential: /(rent|upi to landlord|electric|water|internet|grocer|medical|pharmacy)/,
    discretionary: /(restaurant|foodpanda|swiggy|zomato|uber|ola|movie|subscription|netflix|spotify|prime)/,
    impulse: /(amazon|flipkart|myntra|sale|offer|instabuy|luxury|gadget)/
  };
  let cat = 'discretionary';
  if (patterns.essential.test(text) || patterns.essential.test(merchant)) cat = 'essential';
  if (patterns.impulse.test(text) || patterns.impulse.test(merchant)) cat = 'impulse';
  return { ...tx, amount: amt, category: cat };
}

async function processNightly() {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Primary: read from DB (populated by sms-reader.js)
    const dbTransactions = getRecentTransactions(50);
    const todaySpend = getSpendByCategory(today, today);

    // Fallback: also check sms_inbox.json
    const inbox = await readSMSInbox();
    const labeled = inbox.map(categorize);

    // Merge: prefer DB data, fall back to JSON
    const hasDbData = dbTransactions.length > 0;

    let totals = { essential: 0, discretionary: 0, impulse: 0 };
    let impulseHigh = [];
    let txList = [];

    if (hasDbData) {
      // Use DB data — richer category breakdown
      const catMap = {};
      for (const row of todaySpend) {
        catMap[row.category] = row.total;
      }
      totals = {
        essential: (catMap.rent || 0) + (catMap.utilities || 0) + (catMap.medical || 0) + (catMap.education || 0),
        discretionary: (catMap.food || 0) + (catMap.transport || 0) + (catMap.entertainment || 0),
        impulse: (catMap.shopping || 0) + (catMap.big_spend || 0) + (catMap.tobacco || 0)
      };

      // Flag high impulse + tobacco
      const todayTx = dbTransactions.filter(t => t.date === today && t.type === 'debit');
      impulseHigh = todayTx.filter(t =>
        (t.category === 'shopping' || t.category === 'big_spend' || t.category === 'tobacco') && t.amount > 500
      );
      txList = todayTx;

      // Tobacco alert
      const tobaccoTx = todayTx.filter(t => t.category === 'tobacco');
      if (tobaccoTx.length > 0) {
        const amt = tobaccoTx.reduce((s, t) => s + t.amount, 0);
        await postSlack(`🚨 *TOBACCO ALERT*: ₹${amt.toFixed(0)} spent on cigarettes/weed today. This is going to the Wedding Fund tracker as lost money.`);
      }
    } else {
      // Fallback to JSON
      for (const t of labeled) {
        totals[t.category] += t.amount;
        if (t.category === 'impulse' && t.amount > 500) impulseHigh.push(t);
      }
      txList = labeled.slice(-10);
    }

    const summaryLines = [
      `Essential: ₹${totals.essential.toFixed(0)}`,
      `Discretionary: ₹${totals.discretionary.toFixed(0)}`,
      `Impulse: ₹${totals.impulse.toFixed(0)}`
    ];

    // Build context with category breakdown if from DB
    const ctxLines = ['Categorized transactions (latest):'];
    if (hasDbData && todaySpend.length > 0) {
      ctxLines.push('Category breakdown:');
      todaySpend.forEach(row => ctxLines.push(`  ${row.category}: ₹${row.total.toFixed(0)} (${row.count} txns)`));
      ctxLines.push('');
    }
    ctxLines.push(...txList.slice(-10).map(t =>
      `• [${t.category}] ₹${t.amount} — ${(t.merchant || '')} ${(t.raw_text || t.text || '').slice(0, 60)}`
    ));
    const ctx = ctxLines.join('\n');

    const message = await cfo.run('Summarize today\'s spending and propose actionable savings tips.', ctx);
    await postSlack(`*Spending Summary*\n${summaryLines.join('\n')}\n\n${message}`);

    if (impulseHigh.length) {
      const details = impulseHigh.map(t => `₹${t.amount} ${(t.merchant || '')} ${(t.raw_text || t.text || '').slice(0, 50)}`).join('\n');
      await postSlack(`@here High impulse spends detected (>₹500):\n${details}`);
    }
  } catch (e) {
    console.error('[06-cfobot] nightly processing failed:', e.message);
  }
}

async function updateWeddingFund(monthlyIncome) {
  try {
    const d = getDebt();
    if (!d) return;
    if ((d.debt || 0) === 0 && monthlyIncome > 0) {
      const add = monthlyIncome * 0.20;
      setDebt(d.debt, d.paid, (d.wedding_fund || 0) + add);
      await postSlack(`Wedding fund topped up by ₹${add.toFixed(0)} (20% of monthly income).`);
    }
  } catch (e) {
    console.error('[06-cfobot] updateWeddingFund error:', e.message);
  }
}

async function postDebtProjection() {
  try {
    const d = getDebt();
    if (!d) return;
    const pace = CFO_MONTHLY_DEBT_PAYMENT > 0 ? CFO_MONTHLY_DEBT_PAYMENT : 0; // PLACEHOLDER pace; refine with real payment history later
    let months = 'N/A';
    if (pace > 0 && d.debt > 0) {
      months = Math.ceil(d.debt / pace).toString();
    }
    await postSlack(`Debt payoff projection: current debt ₹${(d.debt||0).toFixed(0)}; assumed monthly payoff ₹${pace.toFixed(0)}; months to zero: ${months}.`);
  } catch (e) {
    console.error('[06-cfobot] debt projection error:', e.message);
  }
}

// Nightly 11PM processing
cron.schedule('0 23 * * *', async () => { await processNightly(); }, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Monthly 1st: projection + (optional) wedding fund top-up if debt is zero
cron.schedule('0 9 1 * *', async () => {
  await postDebtProjection();
  if (CFO_MONTHLY_INCOME > 0) {
    await updateWeddingFund(CFO_MONTHLY_INCOME);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

// Ad-hoc flags
if (process.argv.includes('--process-now')) {
  processNightly();
}
