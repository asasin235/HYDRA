/**
 * scripts/audio-triage.js — Proactive Audio Recording Triage Pipeline
 *
 * Subscribes to `audio.transcribed` bus events (from dashboard ingest).
 * For each new recording:
 *   1. Calls LLM to classify project, meeting type, extract action items
 *   2. Stores triage results in SQLite (recording_briefs + action_items)
 *   3. Posts structured brief to both the project's Slack channel AND #hydra-recordings
 *   4. Publishes `recording.triaged` bus event
 *
 * Modes:
 *   Normal:    Subscribes to bus events, triages new recordings live
 *   Backfill:  node scripts/audio-triage.js --backfill
 *              Reads all audio_transcripts from LanceDB, triages any missing from recording_briefs
 *              (silent — no Slack posting during backfill)
 *
 * PM2: script('audio-triage', './scripts/audio-triage.js')
 */

import { subscribe, publish } from '../core/bus.js';
import {
  saveRecordingBrief, getRecordingBrief, saveActionItem, listRecordingBriefs
} from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { checkBudget } from '../core/bottleneck.js';
import { AGENTS } from '../core/registry.js';
import axios from 'axios';
import crypto from 'crypto';

const log = createLogger('audio-triage');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TRIAGE_MODEL = process.env.TRIAGE_MODEL || 'google/gemini-2.5-flash';
const UNIFIED_CHANNEL = process.env.TRIAGE_UNIFIED_CHANNEL || '#hydra-recordings';
const IS_BACKFILL = process.argv.includes('--backfill');

// ── Project → Channel mapping ─────────────────────────────────────────────────

const PROJECT_CHANNELS = {
  edmo:      AGENTS['01-edmobot']?.slackChannel || '#01-edmobot',
  hydra:     AGENTS['00-architect']?.slackChannel || '#00-architect',
  trading:   AGENTS['09-wolf']?.slackChannel || '#09-wolf',
  finance:   AGENTS['06-cfobot']?.slackChannel || '#06-cfobot',
  health:    AGENTS['07-biobot']?.slackChannel || '#07-biobot',
  personal:  AGENTS['03-sahibabot']?.slackChannel || '#03-sahibabot',
  freelance: AGENTS['10-mercenary']?.slackChannel || '#10-mercenary',
  career:    AGENTS['12-careerbot']?.slackChannel || '#12-careerbot',
  general:   AGENTS['00-architect']?.slackChannel || '#00-architect',
};

const PROJECT_EMOJI = {
  edmo: '💼', hydra: '🐉', trading: '📈', finance: '💰',
  health: '🏃', personal: '❤️', freelance: '🎯', career: '🚀', general: '📋',
};

// ── LLM Classification ───────────────────────────────────────────────────────

const TRIAGE_SYSTEM_PROMPT = `You are an audio recording classifier for a personal AI assistant. Given a transcript summary and metadata from an audio recording, classify it and extract structured information.

The user is Aatif Rashid, a backend engineer working at Edmo (iSchoolConnect). He also has personal projects (HYDRA AI system), trading activities, and a personal life.

Return ONLY valid JSON with this schema:
{
  "project": "edmo|hydra|trading|finance|health|personal|freelance|career|general",
  "meeting_type": "standup|1on1|planning|casual|interview|call|brainstorm|review|memo",
  "participants": ["name1", "name2"],
  "action_items": [{"task": "description", "owner": "name or null", "due": "date hint or null"}],
  "decisions": ["decision1"],
  "key_topics": ["topic1", "topic2"],
  "urgency": "high|medium|low",
  "one_line": "One concise line describing what this recording is about"
}

Classification rules:
- "edmo": Edmo/iSchoolConnect, Vapi, EP-* tickets, sprints, standups, work meetings
- "hydra": HYDRA system, PM2, LanceDB, agents, pipelines, AI infrastructure
- "trading": Nifty, IBKR, stocks, options, F&O, market analysis
- "finance": Budget, debt, salary, expenses, EMI, bank, investments (non-trading)
- "health": Gym, sleep, diet, exercise, fitness, smoking, wellness
- "personal": Sahiba, family, home, personal calls, social
- "freelance": Client projects, contracts, invoices, freelance work
- "career": Job search, interviews, resume, career planning
- "general": Anything that doesn't fit above

If the transcript is very short, unclear, or just noise — set project to "general" and urgency to "low".
If no action items are identifiable, return an empty array.
Participants should be identified by name if mentioned; omit Aatif himself.`;

async function classifyRecording(summary, transcript, metadata) {
  if (!OPENROUTER_API_KEY) {
    log.warn('OPENROUTER_API_KEY not set — skipping classification');
    return null;
  }

  const userMsg = [
    `**Filename:** ${metadata.filename || 'unknown'}`,
    `**Duration:** ${metadata.duration_s ? Math.round(metadata.duration_s / 60) + ' minutes' : 'unknown'}`,
    `**Tags:** ${metadata.tags || 'none'}`,
    `**Summary:** ${summary || '(no summary)'}`,
    `**Transcript (first 3000 chars):**`,
    (transcript || '').slice(0, 3000),
  ].join('\n');

  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: TRIAGE_MODEL,
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.1,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'HYDRA Audio Triage',
      },
      timeout: 30000,
    });

    const content = res.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content);
  } catch (err) {
    log.error('LLM classification failed:', err.message);
    return null;
  }
}

// ── Slack Posting ─────────────────────────────────────────────────────────────

async function postSlack(channel, text) {
  if (!SLACK_BOT_TOKEN) {
    log.debug('No SLACK_BOT_TOKEN — skipping Slack post');
    return null;
  }
  try {
    const res = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel, text, unfurl_links: false },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }, timeout: 8000 }
    );
    return res.data?.ts || null;
  } catch (e) {
    log.error(`Slack post to ${channel} failed:`, e.message);
    return null;
  }
}

function formatSlackBrief(triage, metadata) {
  const emoji = PROJECT_EMOJI[triage.project] || '📋';
  const dur = metadata.duration_s ? `${Math.round(metadata.duration_s / 60)}m` : '?m';
  const meetType = triage.meeting_type ? triage.meeting_type.charAt(0).toUpperCase() + triage.meeting_type.slice(1) : '';

  const lines = [
    `🎙️ *New Recording:* "${triage.one_line || metadata.filename || 'Untitled'}"`,
    `${emoji} ${triage.project.charAt(0).toUpperCase() + triage.project.slice(1)}  |  🏷️ ${meetType}  |  ⏱️ ${dur}`,
  ];

  if (triage.participants?.length) {
    lines.push(`👥 ${triage.participants.join(', ')}`);
  }

  if (triage.action_items?.length) {
    lines.push('');
    lines.push('✅ *Action Items:*');
    for (const ai of triage.action_items.slice(0, 5)) {
      const owner = ai.owner ? `*${ai.owner}*: ` : '';
      const due = ai.due ? ` _(${ai.due})_` : '';
      lines.push(`• ${owner}${ai.task}${due}`);
    }
  }

  if (triage.decisions?.length) {
    lines.push('');
    lines.push('🔑 *Decisions:*');
    for (const d of triage.decisions.slice(0, 3)) {
      lines.push(`• ${d}`);
    }
  }

  if (triage.urgency === 'high') {
    lines.push('\n🔴 *High urgency*');
  }

  return lines.join('\n');
}

// ── Core Triage Logic ─────────────────────────────────────────────────────────

async function triageRecording(data, { silent = false } = {}) {
  const { id, transcript, summary, filename, duration_s, tags, timestamp, source } = data;

  // Skip if already triaged
  const existing = getRecordingBrief(id);
  if (existing) {
    log.debug(`Already triaged: ${id}`);
    return existing;
  }

  log.info(`🔍 Triaging: ${filename || id}`);

  // Budget check
  const allowed = await checkBudget('audio-triage');
  if (allowed === false) {
    log.warn('Budget blocked — skipping triage');
    return null;
  }

  // Classify via LLM
  const triage = await classifyRecording(summary, transcript, {
    filename, duration_s, tags
  });

  if (!triage) {
    log.warn(`Classification returned null for ${id}`);
    return null;
  }

  // Save recording brief
  const brief = {
    id,
    external_id: data.externalId || null,
    project: triage.project || 'general',
    meeting_type: triage.meeting_type,
    participants: triage.participants || [],
    action_items: triage.action_items || [],
    decisions: triage.decisions || [],
    key_topics: triage.key_topics || [],
    urgency: triage.urgency || 'medium',
    one_line: triage.one_line,
    filename,
    duration_s,
    transcript_preview: (transcript || '').slice(0, 500),
  };

  saveRecordingBrief(brief);
  log.info(`💾 Saved brief: ${triage.project}/${triage.meeting_type} — "${triage.one_line}"`);

  // Save individual action items
  for (const ai of (triage.action_items || [])) {
    const actionId = `act-${crypto.randomUUID().slice(0, 8)}`;
    saveActionItem({
      id: actionId,
      recording_id: id,
      task: ai.task,
      owner: ai.owner || null,
      due_date: ai.due || null,
      project: triage.project,
      status: 'open',
    });
  }

  // Post to Slack (unless backfill/silent)
  if (!silent) {
    const slackMsg = formatSlackBrief(triage, { filename, duration_s });
    const projectChannel = PROJECT_CHANNELS[triage.project] || PROJECT_CHANNELS.general;

    // Post to project-specific channel
    const ts1 = await postSlack(projectChannel, slackMsg);
    brief.slack_channel = projectChannel;
    brief.slack_ts = ts1;

    // Post to unified feed channel
    await postSlack(UNIFIED_CHANNEL, slackMsg);

    if (ts1) {
      // Update brief with Slack message ts
      saveRecordingBrief(brief);
    }

    log.info(`📢 Slack: ${projectChannel} + ${UNIFIED_CHANNEL}`);
  }

  // Publish bus event
  try {
    await publish('recording.triaged', {
      id, project: triage.project, meeting_type: triage.meeting_type,
      one_line: triage.one_line, urgency: triage.urgency,
      action_items_count: (triage.action_items || []).length,
      slack_channel: brief.slack_channel,
    });
  } catch { /* bus errors are non-fatal */ }

  return brief;
}

// ── Backfill Mode ─────────────────────────────────────────────────────────────

async function runBackfill() {
  log.info('🔄 Starting backfill of existing audio transcripts...');

  try {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(
      (process.env.BRAIN_PATH || '~/hydra-brain') + '/lancedb'
    );
    const table = await db.openTable('audio_transcripts');
    const rows = await table.query()
      .select(['id', 'source', 'timestamp', 'filename', 'transcript', 'summary', 'duration_s', 'tags'])
      .limit(500)
      .toArray();

    log.info(`Found ${rows.length} audio transcripts to check`);

    let triaged = 0;
    let skipped = 0;

    for (const row of rows) {
      const existing = getRecordingBrief(row.id);
      if (existing) {
        skipped++;
        continue;
      }

      await triageRecording({
        id: row.id,
        source: row.source,
        timestamp: row.timestamp,
        filename: row.filename,
        transcript: row.transcript,
        summary: row.summary,
        duration_s: row.duration_s,
        tags: row.tags,
      }, { silent: true });

      triaged++;

      // Rate limit: 500ms between LLM calls during backfill
      await new Promise(r => setTimeout(r, 500));
    }

    log.info(`✅ Backfill complete: ${triaged} triaged, ${skipped} already done`);
  } catch (err) {
    log.error('Backfill failed:', err.message);
  }

  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (IS_BACKFILL) {
  runBackfill();
} else {
  log.info('🎙️ Audio triage service starting...');
  log.info(`Model: ${TRIAGE_MODEL}`);
  log.info(`Unified channel: ${UNIFIED_CHANNEL}`);

  subscribe('audio.transcribed', async (data) => {
    try {
      await triageRecording(data);
    } catch (err) {
      log.error('Triage failed for event:', err.message);
    }
  });

  log.info('✅ Subscribed to audio.transcribed — waiting for new recordings...');

  // Keep process alive
  setInterval(() => {}, 1 << 30);
}
