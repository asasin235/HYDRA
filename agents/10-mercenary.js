import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';

validateEnv();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#10-mercenary';
const BRAIN_PATH = process.env.BRAIN_PATH || process.env.PI_SMB_PATH || './brain';
const LEADS_INBOX = path.join(BRAIN_PATH, 'brain', '10_MERCENARY', 'leads_inbox.json');
const PROPOSALS_DIR = path.join(BRAIN_PATH, 'brain', '10_MERCENARY', 'proposals');
const INVOICES_DIR = path.join(BRAIN_PATH, 'brain', '10_MERCENARY', 'invoices');

const merc = new Agent({
  name: '10-mercenary',
  model: 'anthropic/claude-sonnet-4',
  systemPromptPath: 'prompts/10-mercenary.txt',
  tools: [],
  namespace: '10_MERCENARY',
  tokenBudget: 300000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[10-mercenary] Slack post error:', e.message);
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function scanLeads() {
  try {
    const exists = await fs.pathExists(LEADS_INBOX);
    if (!exists) return [];
    const raw = await fs.readJson(LEADS_INBOX);
    const leads = Array.isArray(raw) ? raw : [];

    const evaluated = [];
    for (const lead of leads) {
      if (lead.status && lead.status !== 'new') continue; // already processed
      const ctx = JSON.stringify(lead);
      const evaluation = await merc.run(
        `Evaluate this freelance lead. Criteria: budget fit (₹15K-₹50K range), timeline (max 4 weeks), tech match for a senior full-stack JS/TS developer. Output JSON: {decision: "accept"|"reject"|"negotiate", reason: string, counter_budget?: string}`,
        `Lead: ${ctx}`
      );
      let parsed;
      try {
        const match = evaluation.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : { decision: 'reject', reason: 'parse error' };
      } catch {
        parsed = { decision: 'reject', reason: 'parse error' };
      }
      evaluated.push({ ...lead, evaluation: parsed });
    }
    return evaluated;
  } catch (e) {
    console.error('[10-mercenary] scanLeads error:', e.message);
    return [];
  }
}

async function generateProposal(lead) {
  try {
    await fs.ensureDir(PROPOSALS_DIR);
    const ctx = typeof lead === 'object' ? JSON.stringify(lead, null, 2) : lead;
    const proposal = await merc.run(
      `Write a professional freelance proposal. Structure:
1. Understanding (restate their problem clearly)
2. Approach (concrete 3-step technical plan)
3. Timeline (week-by-week milestones, max 4 weeks)
4. Pricing (quote in ₹15K-₹50K range based on scope)
5. Why Me (2-3 sentences, no generic fluff)
Tone: confident, no-BS, client-first.`,
      `Lead details:\n${ctx}`
    );

    const date = new Date().toISOString().split('T')[0];
    const client = (lead.client || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `proposal_${client}_${date}.md`;
    await fs.writeFile(path.join(PROPOSALS_DIR, filename), proposal, 'utf-8');
    return { filename, proposal: proposal.slice(0, 500) };
  } catch (e) {
    return { error: e.message };
  }
}

async function createInvoice(project) {
  try {
    await fs.ensureDir(INVOICES_DIR);
    const date = new Date().toISOString().split('T')[0];
    const client = (project.client || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const invoiceNumber = `INV-${Date.now()}`;
    const invoice = {
      invoice_number: invoiceNumber,
      date,
      client: project.client,
      items: project.items || [{ description: project.description || 'Freelance development work', amount: project.amount || 0 }],
      total: project.amount || project.items?.reduce((s, i) => s + (i.amount || 0), 0) || 0,
      payment_terms: 'Net 7 days',
      bank_details: process.env.BANK_DETAILS || '(configure BANK_DETAILS env var)',
      upi: process.env.UPI_ID || '(configure UPI_ID env var)',
      status: 'pending'
    };

    const filename = `invoice_${client}_${date}.json`;
    await fs.writeJson(path.join(INVOICES_DIR, filename), invoice, { spaces: 2 });
    return { filename, invoice_number: invoiceNumber, total: invoice.total };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Cron ─────────────────────────────────────────────────────────────────────

// 8PM daily: scan leads
cron.schedule('0 20 * * *', async () => {
  try {
    const leads = await scanLeads();
    if (!leads.length) {
      await postSlack('No new leads today.');
      return;
    }

    const accepted = leads.filter(l => l.evaluation?.decision === 'accept');
    const negotiate = leads.filter(l => l.evaluation?.decision === 'negotiate');
    const rejected = leads.filter(l => l.evaluation?.decision === 'reject');

    let msg = `*Lead Scan Summary*\n✅ Accept: ${accepted.length} | 🔄 Negotiate: ${negotiate.length} | ❌ Reject: ${rejected.length}\n`;

    for (const lead of accepted) {
      const result = await generateProposal(lead);
      msg += `\n*${lead.client}* (accept) — proposal: ${result.filename || result.error}`;
    }
    for (const lead of negotiate) {
      msg += `\n*${lead.client}* (negotiate) — ${lead.evaluation?.reason} | Counter: ${lead.evaluation?.counter_budget || 'TBD'}`;
    }
    for (const lead of rejected) {
      msg += `\n*${lead.client}* (reject) — ${lead.evaluation?.reason}`;
    }

    await postSlack(msg);
  } catch (e) {
    console.error('[10-mercenary] nightly scan failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

export { scanLeads, generateProposal, createInvoice };

if (process.argv.includes('--scan-now')) {
  scanLeads().then(leads => console.log(JSON.stringify(leads, null, 2)));
}
