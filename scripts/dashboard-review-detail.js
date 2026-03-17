/**
 * Dashboard Review Detail — Express routes for the detailed conversation review screen.
 * Provides full transcript view, audio playback, participant tagging, and review actions.
 * @module scripts/dashboard-review-detail
 */
import { Router } from 'express';
import { getQueueItem, updateQueueItem } from '../core/review-queue-db.js';
import { getTranscriptByReviewQueueId } from '../core/transcript-store.js';
import { getClassificationByReviewQueueId } from '../core/interaction-classifier.js';
import { listParticipantsByInteraction } from '../core/interaction-participants-db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-review-detail');
const router = Router();

/**
 * GET /review/:id — Detailed review screen (HTML)
 */
router.get('/:id', (req, res) => {
  const item = getQueueItem(req.params.id);
  if (!item) return res.status(404).send('<h1>Review item not found</h1>');

  const transcript = getTranscriptByReviewQueueId(req.params.id);
  const classification = getClassificationByReviewQueueId(req.params.id);
  const participants = item.interaction_id ? listParticipantsByInteraction(item.interaction_id) : [];

  res.send(renderReviewDetailPage(item, transcript, classification, participants));
});

/**
 * PUT /review/api/queue/:id — Update queue item (status, notes, overrides)
 */
router.put('/api/queue/:id', (req, res) => {
  try {
    const updated = updateQueueItem(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Queue item not found' });
    log.info({ id: req.params.id }, 'Queue item updated via API');
    res.json({ success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to update queue item');
    res.status(500).json({ error: e.message });
  }
});

function renderReviewDetailPage(item, transcript, classification, participants) {
  const rawTranscript = transcript?.raw_transcript || 'No transcript available';
  const normalizedSummary = transcript?.normalized_summary || 'No summary available';
  const metadata = (() => { try { return JSON.parse(item.metadata || '{}'); } catch { return {}; } })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review: ${item.source_file || item.id} — HYDRA</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    .back-link { color: #58a6ff; text-decoration: none; font-size: 14px; }
    .back-link:hover { text-decoration: underline; }
    h1 { color: #58a6ff; margin: 16px 0 8px; font-size: 24px; }
    .meta-row { display: flex; gap: 16px; margin-bottom: 24px; color: #8b949e; font-size: 14px; flex-wrap: wrap; }
    .meta-row span { background: #21262d; padding: 4px 10px; border-radius: 12px; }
    .section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .section h2 { color: #f0f6fc; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
    .transcript-box { white-space: pre-wrap; font-family: 'SF Mono', monospace; font-size: 13px; line-height: 1.6; max-height: 400px; overflow-y: auto; background: #0d1117; padding: 16px; border-radius: 6px; border: 1px solid #21262d; }
    .summary-box { font-size: 15px; line-height: 1.6; color: #e6edf3; }
    .audio-player { width: 100%; margin: 12px 0; }
    .participants-list { list-style: none; }
    .participants-list li { padding: 8px 0; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
    .classification-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .class-item { background: #0d1117; padding: 12px; border-radius: 6px; border: 1px solid #21262d; }
    .class-item .label { font-size: 12px; color: #8b949e; text-transform: uppercase; }
    .class-item .value { font-size: 16px; font-weight: 500; margin-top: 4px; }
    .actions { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
    .btn-approve { background: #238636; color: white; }
    .btn-approve:hover { background: #2ea043; }
    .btn-save { background: #1f6feb; color: white; }
    .btn-save:hover { background: #388bfd; }
    .btn-archive { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
    .btn-archive:hover { background: #30363d; }
    .btn-rerun { background: #f0883e33; color: #f0883e; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-needs_review { background: #f0883e33; color: #f0883e; }
    .badge-reviewed { background: #58a6ff33; color: #58a6ff; }
    .badge-approved { background: #23863633; color: #3fb950; }
    #status-msg { margin-top: 12px; font-size: 14px; color: #3fb950; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/review" class="back-link">← Back to queue</a>
    <h1>🔍 ${item.source_file || 'Conversation Review'}</h1>
    <div class="meta-row">
      <span>Status: <span class="badge badge-${item.status}">${(item.status || '').replace('_', ' ')}</span></span>
      <span>Language: ${item.language || 'unknown'}</span>
      <span>Source: ${item.source || '—'}</span>
      <span>Created: ${item.created_at || '—'}</span>
    </div>

    ${item.source_file ? `
    <div class="section">
      <h2>🎵 Audio Playback</h2>
      <audio class="audio-player" controls preload="metadata">
        <source src="/audio/${encodeURIComponent(item.source_file)}" type="audio/mpeg">
        Your browser does not support audio playback.
      </audio>
      <p style="font-size: 12px; color: #8b949e; margin-top: 4px;">Duration: ${transcript?.duration_seconds ? Math.round(transcript.duration_seconds) + 's' : 'unknown'} | Words: ${transcript?.word_count || 0}</p>
    </div>
    ` : ''}

    <div class="section">
      <h2>📝 Normalized Summary (Interpretation)</h2>
      <div class="summary-box">${normalizedSummary}</div>
    </div>

    <div class="section">
      <h2>🎙️ Raw Transcript (Evidence)</h2>
      <div class="transcript-box">${rawTranscript}</div>
    </div>

    <div class="section" id="classification-section">
      <h2>🏷️ Classification</h2>
      <div class="classification-grid">
        <div class="class-item">
          <div class="label">Relationship</div>
          <div class="value" id="rel-type">${classification?.relationship_type || 'unknown'}</div>
        </div>
        <div class="class-item">
          <div class="label">Domain</div>
          <div class="value" id="domain">${classification?.domain || 'unknown'}</div>
        </div>
        <div class="class-item">
          <div class="label">Sensitivity</div>
          <div class="value" id="sensitivity">${classification?.sensitivity || 'low'}</div>
        </div>
        <div class="class-item">
          <div class="label">Source</div>
          <div class="value">${classification?.human_override ? '👤 Human' : '🤖 Auto'}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>👥 Participants</h2>
      ${participants.length === 0 ? '<p style="color: #8b949e;">No participants tagged yet. Use the tagging UI below to add participants.</p>' : `
      <ul class="participants-list">
        ${participants.map(p => `<li><span>${p.speaker_label || 'Unknown'}</span><span style="color: #8b949e;">${p.person_id ? 'Linked' : 'Unlinked'}</span></li>`).join('')}
      </ul>
      `}
    </div>

    <div class="section">
      <h2>📝 Review Notes</h2>
      <textarea id="review-notes" style="width: 100%; min-height: 100px; background: #0d1117; border: 1px solid #21262d; color: #c9d1d9; padding: 12px; border-radius: 6px; font-family: inherit; font-size: 14px; resize: vertical;" placeholder="Add review notes...">${item.review_notes || ''}</textarea>
    </div>

    <div class="actions">
      <button class="btn btn-save" onclick="saveReview()">Save Draft</button>
      <button class="btn btn-approve" onclick="approveReview()">Approve & Ingest</button>
      <button class="btn btn-archive" onclick="archiveReview()">Archive</button>
      <button class="btn btn-rerun" onclick="rerunClassification()">Re-run Classification</button>
    </div>
    <div id="status-msg"></div>
  </div>

  <script>
    const QUEUE_ID = '${item.id}';

    async function updateItem(data) {
      const res = await fetch('/review/api/queue/' + QUEUE_ID, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return res.json();
    }

    async function saveReview() {
      const notes = document.getElementById('review-notes').value;
      await updateItem({ status: 'reviewed', review_notes: notes });
      showStatus('Draft saved.');
    }

    async function approveReview() {
      const notes = document.getElementById('review-notes').value;
      await updateItem({ status: 'approved', review_notes: notes });
      showStatus('Approved! Memory ingestion will proceed.');
    }

    async function archiveReview() {
      await updateItem({ status: 'archived' });
      showStatus('Archived.');
    }

    async function rerunClassification() {
      await updateItem({ status: 'needs_review', rerun_classification: true });
      showStatus('Classification re-run queued. Refresh to see updated results.');
    }

    function showStatus(msg) {
      const el = document.getElementById('status-msg');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
  </script>
</body>
</html>`;
}

export default router;
