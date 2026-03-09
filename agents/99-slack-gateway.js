import { App } from '@slack/bolt';
import { existsSync } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import Agent from '../core/agent.js';
import { getMonthlySpend, getTodaySpend } from '../core/bottleneck.js';
import { getDebt, getState, setState, getTransactions, getDailySpend, getSpendByCategory, getRecentTransactions } from '../core/db.js';
import { appendBrain } from '../core/filesystem.js';
import { AGENTS } from '../core/registry.js';
import axios from 'axios';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';

function assertEnv() {
  const missing = [];
  if (!SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!SLACK_SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET');
  if (!SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN');
  if (missing.length) {
    console.error('[slack-gateway] Missing env:', missing.join(', '));
    process.exit(1);
  }
}

assertEnv();

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// WS-aware watchdog: checks actual WebSocket readyState every 30s.
// Restarts after 90s of confirmed dead state — PM2 restarts fresh,
// which resets numOfConsecutiveReconnectionFailures to 0.
// (auth.test only tests HTTP, not WebSocket — do NOT use it here)
let wsDownSince = null;
setInterval(() => {
  try {
    const wsActive = app.receiver?.client?.websocket?.isActive() ?? false;
    if (wsActive) {
      wsDownSince = null;
    } else {
      if (!wsDownSince) wsDownSince = Date.now();
      const downMs = Date.now() - wsDownSince;
      console.warn(`[slack-gateway] WebSocket inactive for ${Math.round(downMs / 1000)}s`);
      if (downMs >= 90_000) {
        console.error('[slack-gateway] WebSocket dead 90s — restarting');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn('[slack-gateway] watchdog check error (non-fatal):', e.message);
  }
}, 30_000);

// Raw event logger — helps debug what events arrive from Slack
app.use(async ({ payload, next }) => {
  const type = payload?.type || payload?.event?.type || 'unknown';
  if (type !== 'unknown') {
    console.log(`[slack-gateway] event: ${type}`);
  }
  await next();
});

// Lazy agent registry
const agentRegistry = new Map();

// Dedup and rate limiting
const processed = new Set(); // store last 1000 event IDs
const lastByUser = new Map(); // user -> timestamp ms

// Build channel-name → agent-name map from registry
const channelToAgent = new Map();
for (const [agentName, cfg] of Object.entries(AGENTS)) {
  if (cfg.slackChannel) {
    channelToAgent.set(cfg.slackChannel.replace('#', ''), agentName);
  }
}

// Cache: channel ID → channel name (populated lazily)
const channelIdToName = new Map();

async function resolveChannelName(channelId) {
  if (channelIdToName.has(channelId)) return channelIdToName.get(channelId);
  try {
    const res = await app.client.conversations.info({ channel: channelId });
    const name = res.channel?.name || '';
    channelIdToName.set(channelId, name);
    return name;
  } catch { return ''; }
}


function remember(id) {
  processed.add(id);
  if (processed.size > 1000) {
    // remove oldest by recreating set from last 1000 entries
    const arr = Array.from(processed);
    processed.clear();
    for (const v of arr.slice(-1000)) processed.add(v);
  }
}

async function logDrop(entry) {
  try {
    await appendBrain('errors', 'slack_drops.json', { ...entry, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[slack-gateway] drop log error:', e.message);
  }
}

// Edmobot tools — defined here so the gateway can create an edmobot Agent with
// full Jira/GitHub capabilities without importing the edmobot module (which
// registers SIGTERM handlers, crons, and a health server that conflict with the gateway).
import {
  isJiraConfigured, getMyTickets, getTicketDetails,
  transitionTicket, addJiraComment
} from '../core/jira.js';
import {
  isGitHubConfigured, getFileContent, searchCode, listFiles,
  getUserProfile, getUserRepos, getContributionStats,
  createBranch, updateFile, createPR
} from '../core/github.js';
import {
  triageEmails, searchEmails, sendEmail,
  getAgenda, insertEvent, listSpaces, listMessages, sendChatMessage,
  NOT_AUTHED_MSG as GWS_NOT_AUTHED,
} from '../core/gws.js';

const EDMOBOT_TOOLS = [
  {
    name: 'list_my_tickets',
    description: 'List all Jira tickets assigned to Aatif. Shows key, status, priority, and summary.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      if (!isJiraConfigured()) return 'Jira not configured.';
      const tickets = await getMyTickets();
      if (tickets.length === 0) return 'No tickets assigned to you.';
      return tickets.map(t => `${t.key} [${t.status}] ${t.priority || ''} — ${t.summary}`).join('\n');
    }
  },
  {
    name: 'get_ticket_details',
    description: 'Get full details of a specific Jira ticket including description, comments, and labels.',
    parameters: { type: 'object', properties: { ticket_key: { type: 'string', description: 'Jira ticket key, e.g. EP-366' } }, required: ['ticket_key'] },
    execute: async ({ ticket_key }) => {
      if (!isJiraConfigured()) return 'Jira not configured.';
      const t = await getTicketDetails(ticket_key);
      let result = `**${t.key}: ${t.summary}**\nStatus: ${t.status} | Priority: ${t.priority}\n`;
      if (t.labels?.length) result += `Labels: ${t.labels.join(', ')}\n`;
      if (t.description) result += `\nDescription:\n${t.description}\n`;
      if (t.comments?.length) {
        result += `\nRecent comments:\n`;
        t.comments.forEach(c => { result += `- ${c.author} (${c.created.split('T')[0]}): ${c.body.slice(0, 200)}\n`; });
      }
      return result;
    }
  },
  {
    name: 'update_ticket_status',
    description: 'Transition a Jira ticket to a new status.',
    parameters: { type: 'object', properties: { ticket_key: { type: 'string' }, status: { type: 'string' } }, required: ['ticket_key', 'status'] },
    execute: async ({ ticket_key, status }) => {
      if (!isJiraConfigured()) return 'Jira not configured.';
      await transitionTicket(ticket_key, status);
      return `✅ ${ticket_key} transitioned to "${status}"`;
    }
  },
  {
    name: 'comment_on_ticket',
    description: 'Add a comment to a Jira ticket.',
    parameters: { type: 'object', properties: { ticket_key: { type: 'string' }, comment: { type: 'string' } }, required: ['ticket_key', 'comment'] },
    execute: async ({ ticket_key, comment }) => {
      if (!isJiraConfigured()) return 'Jira not configured.';
      await addJiraComment(ticket_key, comment);
      return `✅ Comment added to ${ticket_key}`;
    }
  },
  {
    name: 'search_repo_code',
    description: 'Search for code patterns in a GitHub repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, query: { type: 'string' } }, required: ['repo', 'query'] },
    execute: async ({ repo, query }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      const results = await searchCode(repo, query);
      if (results.length === 0) return `No results for "${query}" in ${repo}`;
      return results.map(r => r.path).join('\n');
    }
  },
  {
    name: 'read_repo_file',
    description: 'Read a file from a GitHub repository.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, file_path: { type: 'string' }, branch: { type: 'string' } }, required: ['repo', 'file_path'] },
    execute: async ({ repo, file_path, branch }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      const file = await getFileContent(repo, file_path, branch);
      return `File: ${file.path}\n\`\`\`\n${file.content.slice(0, 8000)}\n\`\`\``;
    }
  },
  {
    name: 'list_repo_files',
    description: 'List files and directories in a repository path.',
    parameters: { type: 'object', properties: { repo: { type: 'string' }, directory: { type: 'string' }, branch: { type: 'string' } }, required: ['repo'] },
    execute: async ({ repo, directory, branch }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      const files = await listFiles(repo, directory, branch);
      const listing = files.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.path}`).join('\n');
      return listing.slice(0, 4000);
    }
  },
  {
    name: 'create_branch',
    description: 'Create a new git branch in a GitHub repository from an existing base branch.',
    parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, branch_name: { type: 'string' }, base_branch: { type: 'string', description: 'Base branch to create from (default: main)' } }, required: ['repo', 'branch_name'] },
    execute: async ({ repo, branch_name, base_branch = 'main' }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      const result = await createBranch(repo, branch_name, base_branch);
      return `✅ Branch "${branch_name}" created from "${base_branch}" (${result.sha.slice(0, 7)})`;
    }
  },
  {
    name: 'write_repo_file',
    description: 'Create or update a file in a GitHub repository branch. Use this to commit agents.md, README.md, or any documentation file.',
    parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, file_path: { type: 'string', description: 'Path to file e.g. docs/agents.md' }, content: { type: 'string', description: 'Full file content' }, message: { type: 'string', description: 'Commit message' }, branch: { type: 'string', description: 'Branch to commit to' } }, required: ['repo', 'file_path', 'content', 'message', 'branch'] },
    execute: async ({ repo, file_path, content, message, branch }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      // Try to get existing file SHA (needed for updates)
      let sha;
      try { const existing = await getFileContent(repo, file_path, branch); sha = existing.sha; } catch { /* new file */ }
      const result = await updateFile(repo, file_path, content, message, branch, sha);
      return `✅ "${file_path}" ${sha ? 'updated' : 'created'} on branch "${branch}" (commit: ${result.commit_sha?.slice(0, 7)})`;
    }
  },
  {
    name: 'create_pull_request',
    description: 'Create a GitHub pull request from a feature branch into the base branch.',
    parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, title: { type: 'string' }, body: { type: 'string', description: 'PR description in markdown' }, head: { type: 'string', description: 'Feature branch name' }, base: { type: 'string', description: 'Target branch (default: main)' } }, required: ['repo', 'title', 'body', 'head'] },
    execute: async ({ repo, title, body, head, base = 'main' }) => {
      if (!isGitHubConfigured()) return 'GitHub not configured.';
      const pr = await createPR(repo, title, body, head, base);
      return `✅ PR #${pr.number} created: ${pr.html_url}`;
    }
  },
  // ── Google Workspace (work account) ─────────────────────────────────────────
  {
    name: 'check_work_email',
    description: 'List recent unread emails from the work inbox (aatif.rashid@goedmo.com).',
    parameters: { type: 'object', properties: { hours: { type: 'number' }, max: { type: 'number' } }, required: [] },
    execute: async ({ hours, max = 20 } = {}) => {
      const query = hours
        ? `is:unread in:inbox newer_than:${hours}h -category:promotions -category:social`
        : 'is:unread in:inbox -category:promotions -category:social';
      const emails = await triageEmails('work', { max, query });
      if (!emails) return GWS_NOT_AUTHED;
      if (emails.length === 0) return '✉️ No unread work emails.';
      return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}\n   ${(e.snippet || '').slice(0, 150)}`).join('\n\n');
    }
  },
  {
    name: 'search_work_email',
    description: 'Search work Gmail with a Gmail query string.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] },
    execute: async ({ query, max = 10 }) => {
      const emails = await searchEmails('work', query, max);
      if (!emails) return GWS_NOT_AUTHED;
      if (emails.length === 0) return `No emails found for: "${query}"`;
      return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}`).join('\n');
    }
  },
  {
    name: 'send_work_email',
    description: 'Send an email from the work account (aatif.rashid@goedmo.com).',
    parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    execute: async ({ to, subject, body }) => {
      try { await sendEmail('work', { to, subject, body }); return `✅ Email sent to ${to}: "${subject}"`; }
      catch (err) { return `❌ Failed to send: ${err.message}`; }
    }
  },
  {
    name: 'check_gchat',
    description: 'List recent Google Chat messages from work spaces.',
    parameters: { type: 'object', properties: { max_per_space: { type: 'number' } }, required: [] },
    execute: async ({ max_per_space = 10 } = {}) => {
      const spaces = await listSpaces('work');
      if (!spaces) return GWS_NOT_AUTHED;
      if (spaces.length === 0) return 'No Chat spaces found.';
      const results = [];
      for (const space of spaces.slice(0, 5)) {
        const msgs = await listMessages('work', space.name, { pageSize: max_per_space });
        if (!msgs || msgs.length === 0) continue;
        results.push(`**${space.displayName || space.name}**`);
        msgs.forEach(m => results.push(`  ${m.sender?.displayName || 'Unknown'}: ${(m.text || '').slice(0, 200)}`));
      }
      return results.length ? results.join('\n') : 'No recent GChat messages.';
    }
  },
  {
    name: 'send_gchat_message',
    description: 'Send a message to a Google Chat space.',
    parameters: { type: 'object', properties: { space: { type: 'string', description: 'e.g. spaces/AAAAxxxx' }, text: { type: 'string' } }, required: ['space', 'text'] },
    execute: async ({ space, text }) => {
      try { await sendChatMessage('work', space, text); return `✅ Message sent to ${space}`; }
      catch (err) { return `❌ Failed: ${err.message}`; }
    }
  },
  {
    name: 'check_calendar',
    description: 'List upcoming work calendar events.',
    parameters: { type: 'object', properties: { days: { type: 'number' }, today_only: { type: 'boolean' } }, required: [] },
    execute: async ({ days = 2, today_only = false } = {}) => {
      const events = await getAgenda('work', { days, today: today_only });
      if (!events) return GWS_NOT_AUTHED;
      if (events.length === 0) return '📅 No upcoming work calendar events.';
      return events.map(e => {
        const start = e.start?.dateTime || e.start?.date || '';
        const end = e.end?.dateTime || e.end?.date || '';
        const attendees = Array.isArray(e.attendees) ? ` | ${e.attendees.map(a => a.email).slice(0, 5).join(', ')}` : '';
        return `📅 ${e.summary} | ${start} → ${end}${e.location ? ` | 📍 ${e.location}` : ''}${attendees}`;
      }).join('\n');
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new work calendar event.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' }, start: { type: 'string', description: 'ISO 8601' },
        end: { type: 'string', description: 'ISO 8601' }, location: { type: 'string' },
        description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }
      },
      required: ['summary', 'start', 'end']
    },
    execute: async ({ summary, start, end, location, description, attendees = [] }) => {
      try {
        const event = await insertEvent('work', { summary, start, end, location, description, attendees });
        return `✅ Event created: "${summary}" on ${start}${event.htmlLink ? `\n🔗 ${event.htmlLink}` : ''}`;
      } catch (err) { return `❌ Failed: ${err.message}`; }
    }
  }
];

// Socialbot tools — personal Gmail + Calendar (aatif20@gmail.com)
const SOCIALBOT_TOOLS = [
  {
    name: 'check_personal_email',
    description: 'List recent unread personal emails (aatif20@gmail.com).',
    parameters: { type: 'object', properties: { max: { type: 'number' }, hours: { type: 'number' } }, required: [] },
    execute: async ({ max = 15, hours } = {}) => {
      const query = hours
        ? `is:unread in:inbox newer_than:${hours}h -category:promotions -category:social`
        : 'is:unread in:inbox -category:promotions -category:social';
      const emails = await triageEmails('personal', { max, query });
      if (!emails) return GWS_NOT_AUTHED;
      if (emails.length === 0) return '✉️ No unread personal emails.';
      return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}\n   ${(e.snippet || '').slice(0, 150)}`).join('\n\n');
    }
  },
  {
    name: 'search_personal_email',
    description: 'Search personal Gmail with a query.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] },
    execute: async ({ query, max = 10 }) => {
      const emails = await searchEmails('personal', query, max);
      if (!emails) return GWS_NOT_AUTHED;
      if (emails.length === 0) return `No personal emails for: "${query}"`;
      return emails.map(e => `📧 From: ${e.from || e.sender} | ${e.subject} | ${e.date || ''}`).join('\n');
    }
  },
  {
    name: 'send_personal_email',
    description: 'Send an email from the personal account (aatif20@gmail.com).',
    parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    execute: async ({ to, subject, body }) => {
      try { await sendEmail('personal', { to, subject, body }); return `✅ Personal email sent to ${to}`; }
      catch (err) { return `❌ Failed: ${err.message}`; }
    }
  },
  {
    name: 'reply_to_email',
    description: 'Reply to an email from the personal account.',
    parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    execute: async ({ to, subject, body }) => {
      try {
        await sendEmail('personal', { to, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`, body });
        return `✅ Reply sent to ${to}`;
      } catch (err) { return `❌ Failed: ${err.message}`; }
    }
  },
  {
    name: 'check_personal_calendar',
    description: 'List upcoming personal calendar events (aatif20@gmail.com).',
    parameters: { type: 'object', properties: { days: { type: 'number' }, today_only: { type: 'boolean' } }, required: [] },
    execute: async ({ days = 2, today_only = false } = {}) => {
      const events = await getAgenda('personal', { days, today: today_only });
      if (!events) return GWS_NOT_AUTHED;
      if (events.length === 0) return '📅 No upcoming personal calendar events.';
      return events.map(e => {
        const start = e.start?.dateTime || e.start?.date || '';
        const end = e.end?.dateTime || e.end?.date || '';
        return `📅 ${e.summary} | ${start} → ${end}${e.location ? ` | 📍 ${e.location}` : ''}`;
      }).join('\n');
    }
  }
];

// CFO bot tools — query transactions DB populated by sms-reader.js
const CFOBOT_TOOLS = [
  {
    name: 'get_recent_transactions',
    description: 'Get the most recent bank transactions (debits and credits) from SMS. Returns up to 30 transactions with amount, merchant, bank, category, and date.',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max transactions to return (default 20)' } }, required: [] },
    execute: async ({ limit }) => {
      const txs = getRecentTransactions(limit || 20);
      if (txs.length === 0) return 'No transactions found in the database.';
      const lines = txs.map(t => `${t.type === 'debit' ? '🔴 SPENT' : '🟢 RECEIVED'} ₹${t.amount} | ${t.bank} | ${t.merchant || 'N/A'} | ${t.category} | ${t.date}`);
      return `${txs.length} transactions:\n${lines.join('\n')}`;
    }
  },
  {
    name: 'get_spending_by_category',
    description: 'Get total spending broken down by category (food, transport, shopping, utilities, etc.) for a date range.',
    parameters: { type: 'object', properties: { from_date: { type: 'string', description: 'Start date YYYY-MM-DD' }, to_date: { type: 'string', description: 'End date YYYY-MM-DD' } }, required: ['from_date', 'to_date'] },
    execute: async ({ from_date, to_date }) => {
      const cats = getSpendByCategory(from_date, to_date);
      if (cats.length === 0) return `No spending data found between ${from_date} and ${to_date}.`;
      const total = cats.reduce((s, c) => s + c.total, 0);
      const lines = cats.map(c => `${c.category}: ₹${c.total.toFixed(0)} (${c.count} txns)`);
      return `Spending ${from_date} to ${to_date}:\nTotal: ₹${total.toFixed(0)}\n${lines.join('\n')}`;
    }
  },
  {
    name: 'get_daily_spending',
    description: 'Get day-by-day spending breakdown with categories for a date range.',
    parameters: { type: 'object', properties: { from_date: { type: 'string', description: 'Start date YYYY-MM-DD' }, to_date: { type: 'string', description: 'End date YYYY-MM-DD' } }, required: ['from_date', 'to_date'] },
    execute: async ({ from_date, to_date }) => {
      const daily = getDailySpend(from_date, to_date);
      if (daily.length === 0) return `No spending data found between ${from_date} and ${to_date}.`;
      const lines = daily.map(d => `${d.date} | ${d.category}: ₹${d.total.toFixed(0)} (${d.count} txns)`);
      return `Daily spending ${from_date} to ${to_date}:\n${lines.join('\n')}`;
    }
  },
  {
    name: 'get_transactions_by_date',
    description: 'Get all transactions (debits and credits) in a specific date range with full details.',
    parameters: { type: 'object', properties: { from_date: { type: 'string', description: 'Start date YYYY-MM-DD' }, to_date: { type: 'string', description: 'End date YYYY-MM-DD' } }, required: ['from_date', 'to_date'] },
    execute: async ({ from_date, to_date }) => {
      const txs = getTransactions(from_date, to_date);
      if (txs.length === 0) return `No transactions found between ${from_date} and ${to_date}.`;
      const debits = txs.filter(t => t.type === 'debit');
      const credits = txs.filter(t => t.type === 'credit');
      const totalDebit = debits.reduce((s, t) => s + t.amount, 0);
      const totalCredit = credits.reduce((s, t) => s + t.amount, 0);
      const lines = txs.map(t => `${t.type === 'debit' ? '🔴' : '🟢'} ₹${t.amount} | ${t.bank} | ${t.merchant || 'N/A'} | ${t.category} | ${t.date} | card:${t.card || '-'}`);
      return `Transactions ${from_date} to ${to_date}:\nDebits: ₹${totalDebit.toFixed(0)} (${debits.length}) | Credits: ₹${totalCredit.toFixed(0)} (${credits.length})\n${lines.join('\n')}`;
    }
  },
  {
    name: 'get_debt_status',
    description: 'Get current debt tracker status including total debt, amount paid, and wedding fund balance.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const d = getDebt();
      if (!d) return 'Debt tracker not initialized.';
      return `Debt: ₹${(d.debt || 0).toFixed(0)} | Paid: ₹${(d.paid || 0).toFixed(0)} | Wedding Fund: ₹${(d.wedding_fund || 0).toFixed(0)} | Updated: ${d.updated_at || 'N/A'}`;
    }
  }
];


// ── Jarvis HA tools ────────────────────────────────────────────────────────
const HA_URL = (process.env.HOME_ASSISTANT_URL || 'http://192.168.68.68:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN || '';
const haHeaders = () => ({ Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' });

const GW_DEVICE_MAP = {
  aatif_ac:        { domain: 'switch',  entityId: process.env.HA_AC_ENTITY || 'switch.aatif_ac', name: "Aatif's AC" },
  aatif_yellow:    { domain: 'light',   entityId: process.env.HA_BEDROOM_LIGHTS || 'light.4_switch_switch_2', name: "Aatif's Yellow Light" },
  aatif_tubelight: { domain: 'light',   entityId: process.env.HA_DESK_LAMP || 'light.4_switch_switch_4', name: "Aatif's Tubelight" },
  fan:             { domain: 'fan',     entityId: process.env.HA_FAN || 'fan.fan', name: 'Fan' },
  aakif_ac:        { domain: 'switch',  entityId: process.env.HA_AAKIF_AC || 'switch.aakif_ac', name: "Aakif's AC" },
  aakif_tubelight: { domain: 'light',   entityId: 'light.aakif_room_switch_1', name: "Aakif's Tubelight" },
  aakif_light:     { domain: 'light',   entityId: 'light.aakif_room_switch_3', name: "Aakif's Light" },
  aakif_yellow:    { domain: 'light',   entityId: 'light.aakif_room_switch_4', name: "Aakif's Yellow Light" },
  aakif_fan:       { domain: 'fan',     entityId: 'fan.aakif_room_switch_2', name: "Aakif's Fan" },
  saima_yellow:    { domain: 'light',   entityId: 'light.saima_room_switch_2', name: "Saima's Yellow Light" },
  saima_balcony:   { domain: 'light',   entityId: 'light.saima_room_switch_3', name: 'Balcony Light' },
  saima_tubelight: { domain: 'light',   entityId: 'light.saima_room_switch_4', name: "Saima's Tubelight" },
  saima_fan:       { domain: 'fan',     entityId: 'fan.saima_room_switch_1', name: "Saima's Fan" },
  light_strip:     { domain: 'light',   entityId: process.env.HA_LIGHT_STRIP || 'light.light_strip', name: 'Light Strip' },
  humidifier:      { domain: 'switch',  entityId: process.env.HA_HUMIDIFIER || 'switch.humidifier', name: 'Humidifier' },
  geyser:          { domain: 'switch',  entityId: process.env.HA_GEYSER || 'switch.gyeser_plug', name: 'Geyser' },
  xbox_light:      { domain: 'switch',  entityId: process.env.HA_XBOX_LIGHT || 'switch.xbox_light', name: 'Xbox Light' },
};

const GW_SENSOR_MAP = {
  motion: process.env.HA_MOTION_SENSOR || 'binary_sensor.motion_sensor_motion',
  door: process.env.HA_DOOR_SENSOR || 'binary_sensor.side_door_door',
  temperature: process.env.HA_TEMP_SENSOR || 'sensor.temperature_and_humidity_sensor_temperature',
  humidity: process.env.HA_HUMIDITY_SENSOR || 'sensor.temperature_and_humidity_sensor_humidity',
};


// Fuzzy device key resolver: handles aliases like "my fan" → "fan", "bedroom light" → "aatif_yellow"
function resolveDeviceKey(input) {
  if (!input) return input;
  const key = input.toLowerCase().replace(/[\s-]+/g, '_').replace(/['"]/g, '');
  if (GW_DEVICE_MAP[key]) return key;
  // Common aliases
  const aliases = {
    'my_fan': 'fan', 'my_ac': 'aatif_ac', 'my_light': 'aatif_yellow', 'my_tubelight': 'aatif_tubelight',
    'bedroom_fan': 'fan', 'bedroom_ac': 'aatif_ac', 'bedroom_light': 'aatif_yellow',
    'aatif_fan': 'fan', 'ac': 'aatif_ac', 'the_fan': 'fan', 'room_fan': 'fan',
    'living_room_light': 'light_strip', 'strip': 'light_strip', 'led': 'light_strip',
    'water_heater': 'geyser', 'heater': 'geyser', 'xbox': 'xbox_light',
  };
  if (aliases[key]) return aliases[key];
  // Partial match: find first device key containing the input
  const match = Object.keys(GW_DEVICE_MAP).find(k => k.includes(key) || key.includes(k));
  return match || key;
}

async function gwControlDevice(deviceKey, action, value) {
  deviceKey = resolveDeviceKey(deviceKey);
  const d = GW_DEVICE_MAP[deviceKey];
  if (!d) return `Unknown device: ${deviceKey}. Available: ${Object.keys(GW_DEVICE_MAP).join(', ')}`;
  let service, payload;
  if (d.domain === 'switch' || d.domain === 'siren') {
    service = (action === 'turn_on' || action === 'on') ? 'turn_on' : 'turn_off';
    payload = { entity_id: d.entityId };
  } else if (d.domain === 'light') {
    if (action === 'dim' || action === 'brightness') {
      service = 'turn_on'; payload = { entity_id: d.entityId, brightness_pct: Number(value) || 50 };
    } else {
      service = (action === 'turn_on' || action === 'on') ? 'turn_on' : 'turn_off';
      payload = { entity_id: d.entityId };
    }
  } else if (d.domain === 'fan') {
    if (action === 'speed') {
      service = 'set_percentage'; payload = { entity_id: d.entityId, percentage: Number(value) || 50 };
    } else {
      service = (action === 'turn_on' || action === 'on') ? 'turn_on' : 'turn_off';
      payload = { entity_id: d.entityId };
    }
  } else { service = action; payload = { entity_id: d.entityId }; }
  try {
    await axios.post(`${HA_URL}/api/services/${d.domain}/${service}`, payload, { headers: haHeaders() });
    return `\u2705 ${d.name}: ${service}${value !== undefined ? ` (${value})` : ''}`;
  } catch (e) { return `\u274c ${d.name} error: ${e.response?.status || e.message}`; }
}

const JARVIS_TOOLS = [
  {
    name: 'control_device',
    description: 'Control a smart home device. Actions: turn_on, turn_off, dim (lights), speed (fans). Devices: ' + Object.keys(GW_DEVICE_MAP).join(', '),
    parameters: { type: 'object', properties: { device: { type: 'string' }, action: { type: 'string' }, value: { type: 'number' } }, required: ['device', 'action'] },
    execute: async ({ device, action, value }) => await gwControlDevice(device, action, value)
  },
  {
    name: 'read_sensors',
    description: 'Read all sensor values: motion, door, temperature, humidity.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const results = [];
      for (const [name, entityId] of Object.entries(GW_SENSOR_MAP)) {
        try {
          const res = await axios.get(`${HA_URL}/api/states/${entityId}`, { headers: haHeaders() });
          const s = res.data;
          results.push(`${s.attributes?.friendly_name || name}: ${s.state}${s.attributes?.unit_of_measurement ? ' ' + s.attributes.unit_of_measurement : ''}`);
        } catch (e) { results.push(`${name}: error`); }
      }
      return results.join('\n');
    }
  },
  {
    name: 'list_devices',
    description: 'List all smart home devices with their current on/off state.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const results = [];
      for (const [key, d] of Object.entries(GW_DEVICE_MAP)) {
        try {
          const res = await axios.get(`${HA_URL}/api/states/${d.entityId}`, { headers: haHeaders() });
          results.push(`${res.data.state === 'on' ? '\ud83d\udfe2' : '\u26ab'} ${d.name} (${key}) — ${res.data.state}`);
        } catch (e) { results.push(`\u26ab ${d.name} (${key}) — error`); }
      }
      return results.join('\n');
    }
  },
  {
    name: 'sleep_mode',
    description: 'Activate sleep mode: dim Aatif lights to 10%, turn on AC.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const results = [];
      results.push(await gwControlDevice('aatif_yellow', 'dim', 10));
      results.push(await gwControlDevice('aatif_tubelight', 'turn_off'));
      results.push(await gwControlDevice('aatif_ac', 'turn_on'));
      return `\ud83c\udf19 Sleep mode:\n${results.join('\n')}`;
    }
  },
  {
    name: 'get_weather',
    description: 'Get current weather forecast.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      try {
        const res = await axios.get(`${HA_URL}/api/states/weather.forecast_home`, { headers: haHeaders() });
        const w = res.data;
        return `Weather: ${w.state}, ${w.attributes?.temperature}\u00b0C, humidity ${w.attributes?.humidity}%, wind ${w.attributes?.wind_speed} km/h`;
      } catch (e) { return `Weather error: ${e.message}`; }
    }
  }
];

// CareerBot tools — GitHub analysis and skill gap scoring
const GW_GITHUB_USERNAME = process.env.GITHUB_USERNAME || '';

const CAREERBOT_TOOLS = [
  {
    name: 'analyze_github_profile',
    description: 'Analyze a GitHub user profile: repos, languages, contribution patterns, stars, and activity trends.',
    parameters: { type: 'object', properties: { username: { type: 'string', description: 'GitHub username (defaults to GITHUB_USERNAME env)' } }, required: [] },
    execute: async ({ username }) => {
      const user = username || GW_GITHUB_USERNAME;
      if (!user) return 'No GitHub username configured. Set GITHUB_USERNAME in .env.';
      try {
        const [profile, repos, activity] = await Promise.all([
          getUserProfile(user), getUserRepos(user, 50), getContributionStats(user)
        ]);
        if (!profile) return `Could not fetch GitHub profile for ${user}.`;
        const langCount = {};
        for (const repo of repos) { if (repo.language) langCount[repo.language] = (langCount[repo.language] || 0) + 1; }
        const topLangs = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, c]) => `${l}: ${c} repos`);
        const topRepos = repos.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0)).slice(0, 5)
          .map(r => `⭐${r.stargazers_count} ${r.name} (${r.language || 'N/A'}) — ${(r.description || '').slice(0, 80)}`);
        return [
          `## GitHub Profile: ${profile.login}`, `Name: ${profile.name || 'N/A'} | Repos: ${profile.public_repos} | Followers: ${profile.followers}`,
          `Bio: ${profile.bio || 'N/A'}`, '', '### Top Languages', topLangs.join('\n') || 'No data', '', '### Top Repositories',
          topRepos.join('\n') || 'No repos', '', '### Recent Activity',
          `Events: ${activity.totalEvents}`, Object.entries(activity.eventBreakdown || {}).map(([t, c]) => `  ${t}: ${c}`).join('\n'),
          `Active repos: ${(activity.recentRepos || []).slice(0, 5).join(', ') || 'none'}`
        ].join('\n');
      } catch (e) { return `GitHub analysis failed: ${e.message}`; }
    }
  },
  {
    name: 'score_skill_gaps',
    description: 'Compare current skills against a target job description. Returns structured data for gap analysis.',
    parameters: { type: 'object', properties: { job_description: { type: 'string', description: 'Target JD or role requirements' }, current_skills: { type: 'string', description: 'Comma-separated skills (optional, inferred from GitHub if omitted)' } }, required: ['job_description'] },
    execute: async ({ job_description, current_skills }) => {
      let skills = current_skills;
      if (!skills && GW_GITHUB_USERNAME) {
        try {
          const repos = await getUserRepos(GW_GITHUB_USERNAME, 50);
          const langs = [...new Set(repos.map(r => r.language).filter(Boolean))];
          const topics = [...new Set(repos.flatMap(r => r.topics || []))];
          skills = [...langs, ...topics].join(', ');
        } catch { skills = ''; }
      }
      return JSON.stringify({ instruction: 'Analyze skill gaps. Rate each required skill 1-10. Provide overall readiness score and top 3 learning priorities.', current_skills: skills || 'No data — ask user for skills', target_job_description: job_description.slice(0, 3000) }, null, 2);
    }
  },
  { name: 'analyze_resume', description: '(Coming soon) Analyze and diff resume versions.', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => 'Not yet implemented.' },
  { name: 'search_salary_data', description: '(Coming soon) Search salary benchmarks.', parameters: { type: 'object', properties: { role: { type: 'string' }, location: { type: 'string' } }, required: ['role'] }, execute: async () => 'Not yet implemented.' },
  { name: 'analyze_linkedin', description: '(Coming soon) Analyze LinkedIn profile.', parameters: { type: 'object', properties: {}, required: [] }, execute: async () => 'Not yet implemented.' }
];

// Tool map for agents that need tools when created by the gateway
const AGENT_TOOLS = {
  '01-edmobot': EDMOBOT_TOOLS,
  '04-socialbot': SOCIALBOT_TOOLS,
  '05-jarvis': JARVIS_TOOLS,
  '06-cfobot': CFOBOT_TOOLS,
  '12-careerbot': CAREERBOT_TOOLS
};

const OVERRIDES_FILE = path.join(BRAIN_PATH, 'brain', 'dashboard', 'overrides.json');
const EVICT_FILE = path.join(BRAIN_PATH, 'brain', 'dashboard', 'evict.json');
// Track when each cached agent was created (ms timestamp)
const agentCreatedAt = new Map();

async function loadOverrides() {
  try {
    if (await fs.pathExists(OVERRIDES_FILE)) return await fs.readJson(OVERRIDES_FILE);
  } catch { }
  return {};
}

async function getOrCreateAgent(name) {
  // Check if dashboard requested a cache eviction for this agent
  try {
    if (await fs.pathExists(EVICT_FILE)) {
      const evict = await fs.readJson(EVICT_FILE);
      const evictTs = evict[name] || 0;
      const createdTs = agentCreatedAt.get(name) || 0;
      if (evictTs > createdTs) {
        agentRegistry.delete(name);
        agentCreatedAt.delete(name);
      }
    }
  } catch { }

  if (agentRegistry.has(name)) return agentRegistry.get(name);

  const cfg = AGENTS[name] || {};
  // Merge dashboard overrides (model, temperature, maxHistoryTurns) over registry defaults
  const overrides = await loadOverrides();
  const ov = overrides[name] || {};
  const effectiveCfg = { ...cfg, ...ov };

  const promptTxt = path.join('prompts', `${name}.txt`);
  const promptMd = path.join('prompts', `${name}.md`);
  const systemPromptPath = existsSync(promptTxt) ? promptTxt : promptMd;
  const tools = AGENT_TOOLS[name] || [];
  const agent = new Agent({
    name,
    model: effectiveCfg.model || 'anthropic/claude-sonnet-4.6',
    systemPromptPath,
    tools,
    namespace: effectiveCfg.namespace || cfg.namespace || name,
    tokenBudget: tools.length > 0 ? 300000 : 8000,
    useScreenContext: effectiveCfg.useScreenContext !== undefined ? effectiveCfg.useScreenContext : true,
    maxHistoryTurns: effectiveCfg.maxHistoryTurns,
  });
  agentRegistry.set(name, agent);
  agentCreatedAt.set(name, Date.now());
  return agent;
}

// Utility to write pending action results
async function writePendingAction(agentName, approved) {
  try {
    const nsDir = path.join(BRAIN_PATH, 'brain', agentName);
    await fs.ensureDir(nsDir);
    const file = path.join(nsDir, 'pending_action.json');
    await fs.writeJson(file, { approved, ts: Date.now() }, { spaces: 2 });
  } catch (e) {
    console.error('[slack-gateway] writePendingAction error:', e.message);
  }
}

// Core dispatch: handles routing, dedup, rate-limiting, and LLM call.
// agentName defaults to '00-architect' when not explicitly specified.
async function dispatch({ message, say, agentName = '00-architect', userText }) {
  const channelId = message.channel || '';
  const evtId = `${channelId}:${message.ts}`;
  if (processed.has(evtId)) {
    await logDrop({ reason: 'duplicate', evtId, user: message.user, text: message.text });
    return;
  }
  remember(evtId);

  const user = message.user;
  const now = Date.now();
  if (now - (lastByUser.get(user) || 0) < 3000) {
    await say({ thread_ts: message.ts, text: 'Please wait before sending another command.' });
    await logDrop({ reason: 'rate_limited', evtId, user, text: message.text });
    return;
  }
  lastByUser.set(user, now);

  const agent = await getOrCreateAgent(agentName);
  await say({ thread_ts: message.ts, text: `🤖 *${agentName}* is thinking...` });

  const runPromise = agent.run(userText, `Slack user: <@${user}>`);
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 30000));
  const race = await Promise.race([runPromise, timeoutPromise]);

  if (race === 'TIMEOUT') {
    await say({ thread_ts: message.ts, text: `⏳ ${agentName} is still processing...` });
    try {
      const response = await runPromise;
      await say({ thread_ts: message.ts, text: `*${agentName}:* ${response}` });
    } catch (e) {
      console.error('[slack-gateway] delayed run error:', e.message);
    }
  } else {
    await say({ thread_ts: message.ts, text: `*${agentName}:* ${race}` });
  }
}

// Message router: "hydra <agent> <message>" — explicit agent targeting
app.message(/^\s*@?hydra\s+(\S+)\s+([\s\S]+)/i, async ({ message, say, context }) => {
  try {
    const agentName = context.matches[1].trim();
    const userText = context.matches[2].trim();
    await dispatch({ message, say, agentName, userText });
  } catch (error) {
    console.error('[slack-gateway] message handler error:', error.message);
    await say({ thread_ts: message.ts, text: `❌ Error: ${error.message}` });
  }
});

// Mention handler: "@HYDRA_BOT <message>" in any channel — routes to 00-architect
app.event('app_mention', async ({ event, say }) => {
  try {
    // Strip the bot mention prefix (<@UXXXXX>) from the text
    const userText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!userText) {
      await say({ thread_ts: event.ts, text: '👋 Hi! Send me a message like `@hydra how are you?` or DM me directly.' });
      return;
    }
    // Route to the agent whose channel this mention came from, fallback to 00-architect
    const channelName = await resolveChannelName(event.channel);
    const agentName = channelToAgent.get(channelName) || '00-architect';
    await dispatch({ message: event, say, agentName, userText });
  } catch (error) {
    console.error('[slack-gateway] app_mention error:', error.message);
    await say({ thread_ts: event.ts, text: `❌ Error: ${error.message}` });
  }
});

// Channel routing: messages in agent channels (e.g. #06-cfobot) route to that agent
app.message(async ({ message, say }) => {
  // Skip DMs, bot messages, subtypes, and messages already handled by regex
  if (message.channel_type === 'im' || message.subtype || message.bot_id) return;
  if (/^\s*@?hydra\s+\S+\s+/i.test(message.text || '')) return;

  const channelName = await resolveChannelName(message.channel);
  const agentName = channelToAgent.get(channelName);
  if (!agentName) return; // not an agent channel, ignore

  const userText = (message.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!userText) return;

  try {
    await dispatch({ message, say, agentName, userText });
  } catch (error) {
    console.error('[slack-gateway] channel route error:', error.message);
    await say({ thread_ts: message.ts, text: `❌ Error: ${error.message}` });
  }
});

// DM handler: direct messages to the bot → 00-architect
app.message(async ({ message, say }) => {
  // Only handle DMs (channel_type === 'im') and ignore bot messages / subtypes
  if (message.channel_type !== 'im' || message.subtype || message.bot_id) return;
  // Skip if already handled by the regex route above
  if (/^\s*@?hydra\s+\S+\s+/i.test(message.text || '')) return;

  try {
    const userText = (message.text || '').trim();
    if (!userText) return;
    await dispatch({ message, say, agentName: '00-architect', userText });
  } catch (error) {
    console.error('[slack-gateway] DM handler error:', error.message);
    await say({ thread_ts: message.ts, text: `❌ Error: ${error.message}` });
  }
});

// Approve/Reject actions
app.action('hydra_approve', async ({ body, ack, say }) => {
  await ack();
  try {
    const agentName = body.actions?.[0]?.value || 'unknown';
    await writePendingAction(agentName, true);
    await say({ text: `✅ Approved for ${agentName}` });
  } catch (e) {
    console.error('[slack-gateway] approve action error:', e.message);
  }
});

app.action('hydra_reject', async ({ body, ack, say }) => {
  await ack();
  try {
    const agentName = body.actions?.[0]?.value || 'unknown';
    await writePendingAction(agentName, false);
    await say({ text: `❌ Rejected for ${agentName}` });
  } catch (e) {
    console.error('[slack-gateway] reject action error:', e.message);
  }
});

// ── Reflection approval handler ─────────────────────────────────────────────

async function applyReflectionChanges(agentName, weekNum) {
  const AGENT_NS_MAP = {
    '00-architect': '00_ARCHITECT', '01-edmobot': '01_EDMO', '02-brandbot': '02_BRAND',
    '03-sahibabot': '03_SAHIBA', '05-jarvis': '05_JARVIS', '06-cfobot': '06_CFO',
    '07-biobot': '07_BIOBOT', '09-wolf': '09_WOLF', '10-mercenary': '10_MERCENARY'
  };
  const ns = AGENT_NS_MAP[agentName] || agentName;
  const reflFile = path.join(BRAIN_PATH, 'brain', ns, 'reflections', `week_${weekNum}.json`);
  const promptFile = path.join(process.cwd(), 'prompts', `${agentName}.txt`);

  if (!await fs.pathExists(reflFile)) return { error: 'Reflection file not found' };
  const reflection = await fs.readJson(reflFile);
  const changes = reflection.prompt_changes || [];

  let promptText = (await fs.pathExists(promptFile)) ? await fs.readFile(promptFile, 'utf-8') : '';
  const originalPromptText = promptText;

  let applied = 0;
  for (const change of changes) {
    if (!change.current_text || !change.proposed_text) continue;
    if (promptText.includes(change.current_text)) {
      promptText = promptText.replace(change.current_text, change.proposed_text);
      applied++;
    } else {
      // Append as new rule
      promptText += `\n\n## Reflection Update W${weekNum}\n${change.proposed_text}`;
      applied++;
    }
  }

  // Save a dated snapshot of the original prompt before overwriting
  if (originalPromptText) {
    const versionsDir = path.join(process.cwd(), 'prompts', 'versions');
    await fs.ensureDir(versionsDir);
    const dateStr = new Date().toISOString().slice(0, 10);
    let versionFile = path.join(versionsDir, `${agentName}.${dateStr}.txt`);
    if (await fs.pathExists(versionFile)) {
      let seq = 2;
      while (await fs.pathExists(path.join(versionsDir, `${agentName}.${dateStr}.${seq}.txt`))) seq++;
      versionFile = path.join(versionsDir, `${agentName}.${dateStr}.${seq}.txt`);
    }
    await fs.writeFile(versionFile, originalPromptText, 'utf-8');
  }

  await fs.writeFile(promptFile, promptText, 'utf-8');

  try {
    execSync(`git -C ${process.cwd()} add prompts/ && git -C ${process.cwd()} commit -m "reflect: ${agentName} w${weekNum} ${reflection.score}/10"`, { timeout: 10000 });
  } catch (e) {
    console.error('[gateway] git commit error:', e.message);
  }

  // Reload agent in the running process if registered, else restart via PM2
  const runningAgent = agentRegistry.get(agentName);
  if (runningAgent) {
    await runningAgent.reloadPrompt();
  } else {
    try { execSync(`pm2 restart ${agentName} --no-color 2>/dev/null || true`, { timeout: 5000 }); } catch { }
  }

  return { applied, total: changes.length };
}

app.action('reflect_approve', async ({ body, ack, say }) => {
  await ack();
  try {
    const value = body.actions?.[0]?.value || '';
    const [agentName, weekNumStr] = value.split('|');
    const weekNum = Number(weekNumStr);
    const result = await applyReflectionChanges(agentName, weekNum);
    if (result.error) {
      await say({ text: `❌ Reflection approval failed: ${result.error}` });
    } else {
      await say({ text: `✅ ${agentName} updated. ${result.applied}/${result.total} changes applied. Reloaded.` });
    }
  } catch (e) {
    console.error('[slack-gateway] reflect_approve error:', e.message);
    await say({ text: `❌ Error: ${e.message}` });
  }
});

app.action('reflect_skip', async ({ body, ack, say }) => {
  await ack();
  const value = body.actions?.[0]?.value || '';
  const [agentName, weekNum] = value.split('|');

  // Record rejection so auditor doesn't re-propose the same change
  try {
    const existing = getState(agentName, 'rejected_suggestions');
    const rejected = existing ? JSON.parse(existing) : [];
    rejected.push(`Week ${weekNum}: suggestion skipped by user`);
    while (rejected.length > 10) rejected.shift();
    setState(agentName, 'rejected_suggestions', JSON.stringify(rejected));
  } catch (e) {
    console.error('[slack-gateway] rejection tracking error:', e.message);
  }

  await say({ text: `⏭ Skipped reflection for ${agentName} week ${weekNum}. Recorded for future context.` });
});

// SabihaBot message draft actions
app.action('sabiha_send', async ({ body, ack, say }) => {
  await ack();
  try {
    const value = (body.actions?.[0]?.value || '').replace(/^send:/, '');
    const { sendWhatsApp } = await import('../core/openclaw.js');
    const result = await sendWhatsApp('Sabiha', value);
    if (result.success) {
      await say({ text: `📤 Sent to Sabiha via WhatsApp: "${value}"` });
    } else {
      await say({ text: `❌ WhatsApp send failed: ${result.error}\n📋 Message: "${value}"` });
    }
  } catch (e) {
    console.error('[slack-gateway] sabiha_send error:', e.message);
    const value = (body.actions?.[0]?.value || '').replace(/^send:/, '');
    await say({ text: `❌ Error: ${e.message}\n📋 Message was: "${value}"` });
  }
});
app.action('sabiha_edit', async ({ body, ack, say }) => {
  await ack();
  const value = (body.actions?.[0]?.value || '').replace(/^edit:/, '');
  await say({ text: `✏️ Edit this draft:\n${value}` });
});
app.action('sabiha_discard', async ({ body, ack, say }) => {
  await ack();
  await say({ text: '🗑️ Draft discarded.' });
});

// SocialBot message actions
app.action('social_send', async ({ body, ack, say }) => {
  await ack();
  try {
    const draftId = body.actions?.[0]?.value || '';
    if (!draftId) {
      await say({ text: '❌ No draft ID found.' });
      return;
    }
    // Dynamically import to avoid circular deps
    const { executeSend } = await import('./04-socialbot.js');
    const result = await executeSend(draftId);
    if (result.success) {
      await say({ text: `📤 Sent to ${result.contact} on ${result.app}!` });
    } else {
      await say({ text: `❌ Send failed: ${result.error}` });
    }
  } catch (e) {
    console.error('[slack-gateway] social_send error:', e.message);
    await say({ text: `❌ Error: ${e.message}` });
  }
});

app.action('social_edit', async ({ body, ack, say }) => {
  await ack();
  try {
    const draftId = body.actions?.[0]?.value || '';
    const { getDraft } = await import('./04-socialbot.js');
    const draft = await getDraft(draftId);
    if (draft) {
      await say({ text: `✏️ Edit draft for *${draft.contact}* (${draft.app}):\n\`\`\`${draft.message}\`\`\`\nReply in thread with your edited message, then use \`@hydra socialbot send ${draftId}\` to send.` });
    } else {
      await say({ text: '❌ Draft not found (may have expired).' });
    }
  } catch (e) {
    console.error('[slack-gateway] social_edit error:', e.message);
    await say({ text: `❌ Error: ${e.message}` });
  }
});

app.action('social_discard', async ({ body, ack, say }) => {
  await ack();
  try {
    const draftId = body.actions?.[0]?.value || '';
    const { removeDraft } = await import('./04-socialbot.js');
    await removeDraft(draftId);
    await say({ text: '🗑️ Social draft discarded.' });
  } catch (e) {
    console.error('[slack-gateway] social_discard error:', e.message);
    await say({ text: `❌ Error: ${e.message}` });
  }
});

// Jira ticket actions (01-edmobot)
app.action('jira_approve', async ({ body, ack, say }) => {
  await ack();
  try {
    const draftId = body.actions?.[0]?.value || '';
    if (!draftId) {
      await say({ text: '❌ No draft ID found.' });
      return;
    }
    const { executeJiraDraft } = await import('./01-edmobot.js');
    const result = await executeJiraDraft(draftId);
    if (result && result.key) {
      await say({ text: `✅ Jira issue created: <https://your-domain.atlassian.net/browse/${result.key}|${result.key}>` });
    } else {
      await say({ text: `✅ Jira issue created.` });
    }
  } catch (e) {
    console.error('[slack-gateway] jira_approve error:', e.message);
    await say({ text: `❌ Failed to create Jira issue: ${e.message}` });
  }
});

app.action('jira_discard', async ({ body, ack, say }) => {
  await ack();
  try {
    const draftId = body.actions?.[0]?.value || '';
    const { discardJiraDraft } = await import('./01-edmobot.js');
    await discardJiraDraft(draftId);
    await say({ text: '🗑️ Jira draft discarded.' });
  } catch (e) {
    console.error('[slack-gateway] jira_discard error:', e.message);
    await say({ text: `❌ Error: ${e.message}` });
  }
});

// /hydra-status command
app.command('/hydra-status', async ({ ack, respond }) => {
  await ack();
  try {
    // PM2 status via API
    const pm2 = await import('pm2');
    const processes = await new Promise((resolve, reject) => {
      pm2.connect(err => {
        if (err) return reject(err);
        pm2.list((err2, list) => {
          pm2.disconnect();
          return err2 ? reject(err2) : resolve(list || []);
        });
      });
    });

    const statuses = processes.map(p => ({ name: p.name, status: p.pm2_env?.status }));

    // Token spend today for known agents in ecosystem
    const agentNames = [
      '00-architect', '01-edmobot', '02-brandbot', '03-sahibabot', '04-socialbot', '05-jarvis', '06-cfobot', '07-biobot', '09-wolf', '10-mercenary', '11-auditor', '99-slack-gateway'
    ];
    const today = await Promise.all(agentNames.map(async n => ({ name: n, ...(await getTodaySpend(n)) })));
    const todayTotal = today.reduce((sum, a) => sum + (a.cost || 0), 0);

    // Debt tracker from SQLite
    const debt = getDebt();

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '*HYDRA Status*' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*PM2*' } },
      { type: 'section', text: { type: 'mrkdwn', text: statuses.map(s => `• ${s.name}: ${s.status}`).join('\n') || 'No processes' } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Today Token Spend:* $${todayTotal.toFixed(4)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: today.map(a => `• ${a.name}: $${(a.cost || 0).toFixed(4)}`).join('\n') } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Debt:* Debt: $${(debt?.debt || 0).toFixed(2)} | Paid: $${(debt?.paid || 0).toFixed(2)} | Wedding: $${(debt?.wedding_fund || 0).toFixed(2)}` } }
    ];

    await respond({ blocks, text: 'HYDRA Status' });
  } catch (error) {
    console.error('[slack-gateway] /hydra-status error:', error.message);
    await respond({ text: `Status error: ${error.message}` });
  }
});

(async () => {
  try {
    await app.start();
    // clientPingTimeoutMS: tolerance for WS ping/pong (10s balanced).
    // NOTE: the SDK also uses this as reconnect delay multiplier:
    //   msBeforeRetry = clientPingTimeoutMS * numOfConsecutiveReconnectionFailures
    // Reset numOfConsecutiveReconnectionFailures=0 to undo yesterday's accumulated delays.
    try {
      app.receiver.client.clientPingTimeoutMS = 10000;
      app.receiver.client.numOfConsecutiveReconnectionFailures = 0;
      app.receiver.client.on('connected', () => console.log('[slack-gateway] WebSocket connected ✓'));
      app.receiver.client.on('disconnected', (err) => console.warn(`[slack-gateway] WebSocket disconnected: ${err?.message || 'unknown'}`));
      app.receiver.client.on('reconnecting', () => console.log('[slack-gateway] WebSocket reconnecting...'));
    } catch (e) { /* non-fatal */ }
    console.log('[slack-gateway] Bolt app running in socket mode');

    // Join all agent channels so app.message() fires for plain (non-mention) messages.
    // Without channel membership, Slack only delivers app_mention events, not message events.
    const agentChannels = Object.values(AGENTS)
      .map(cfg => cfg.slackChannel)
      .filter(Boolean);
    for (const channelName of agentChannels) {
      try {
        // Resolve channel name → ID first (need ID for conversations.join)
        const list = await app.client.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
        const channel = list.channels?.find(c => c.name === channelName.replace('#', ''));
        if (channel && !channel.is_member) {
          await app.client.conversations.join({ channel: channel.id });
          console.log(`[slack-gateway] Joined channel #${channel.name}`);
        }
      } catch (e) {
        // Non-fatal: bot may not have channels:join scope or channel may be private
        console.warn(`[slack-gateway] Could not join ${channelName}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('[slack-gateway] failed to start:', error.message);
    process.exit(1);
  }
})();
