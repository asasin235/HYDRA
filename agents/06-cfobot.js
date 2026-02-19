import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { getDebt, setDebt } from '../core/db.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#06-cfobot';
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const CFO_MONTHLY_INCOME = Number(process.env.CFO_MONTHLY_INCOME || 0);
const CFO_MONTHLY_DEBT_PAYMENT = Number(process.env.CFO_MONTHLY_DEBT_PAYMENT || 0);

const cfo = new Agent({
  name: '06-cfobot',
  model: 'deepseek/deepseek-r1',
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
    const inbox = await readSMSInbox();
    const labeled = inbox.map(categorize);
    const totals = { essential: 0, discretionary: 0, impulse: 0 };
    let impulseHigh = [];
    for (const t of labeled) {
      totals[t.category] += t.amount;
      if (t.category === 'impulse' && t.amount > 500) impulseHigh.push(t);
    }

    const summaryLines = [
      `Essential: ₹${totals.essential.toFixed(0)}`,
      `Discretionary: ₹${totals.discretionary.toFixed(0)}`,
      `Impulse: ₹${totals.impulse.toFixed(0)}`
    ];

    const ctx = [
      'Categorized transactions (latest):',
      ...labeled.slice(-10).map(t => `• [${t.category}] ₹${t.amount} — ${(t.merchant||'')} ${(t.text||'').slice(0,60)}`)
    ].join('\n');

    const message = await cfo.run('Summarize today\'s spending and propose actionable savings tips.', ctx);
    await postSlack(`*Spending Summary*\n${summaryLines.join('\n')}\n\n${message}`);

    if (impulseHigh.length) {
      const details = impulseHigh.map(t => `₹${t.amount} ${(t.merchant||'')} ${(t.text||'').slice(0,50)}`).join('\n');
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
