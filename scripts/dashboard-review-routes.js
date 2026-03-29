/**
 * Dashboard Review Routes — Express router for the conversation review queue.
 * Provides list view, filtering, queue management, and bulk hard-delete endpoints.
 * Mount on the main dashboard app: app.use('/review', reviewRouter)
 * @module scripts/dashboard-review-routes
 */
import { Router } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { listQueue, getQueueItem, updateQueueItem, getQueueStats } from '../core/review-queue-db.js';
import { getTranscriptByReviewQueueId } from '../core/transcript-store.js';
import { getClassificationByReviewQueueId } from '../core/interaction-classifier.js';
import { db } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-review-routes');
const router = Router();

const AUDIO_INBOX = (process.env.AUDIO_INBOX_DIR || '~/hydra-brain/audio_inbox')
    .replace(/^~/, process.env.HOME);

/**
 * GET /review — Review queue list page (HTML)
 */
router.get('/', (req, res) => {
  const { status, language, page = 1, limit = 25 } = req.query;
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

  const filters = {};
  if (status) filters.status = status;
  if (language) filters.language = language;

  const items = listQueue({ ...filters, limit: Number(limit), offset });
  const stats = getQueueStats();

  res.send(renderReviewQueuePage(items, stats, { status, language, page: Number(page), limit: Number(limit) }));
});

/**
 * GET /review/api/queue — JSON API for queue items
 */
router.get('/api/queue', (req, res) => {
  const { status, language, limit = 25, offset = 0 } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (language) filters.language = language;

  const items = listQueue({ ...filters, limit: Number(limit), offset: Number(offset) });
  const stats = getQueueStats();
  res.json({ items, stats });
});

/**
 * GET /review/api/queue/:id — Single queue item with transcript and classification
 */
router.get('/api/queue/:id', (req, res) => {
  const item = getQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Queue item not found' });

  const transcript = getTranscriptByReviewQueueId(req.params.id);
  const classification = getClassificationByReviewQueueId(req.params.id);

  res.json({ item, transcript, classification });
});

/**
 * GET /review/api/stats — Queue statistics
 */
router.get('/api/stats', (req, res) => {
  const stats = getQueueStats();
  res.json(stats);
});

/**
 * DELETE /review/api/review-queue/bulk — Hard delete selected queue items.
 *
 * Body: { ids: [id1, id2, ...] }
 *
 * For each ID this endpoint:
 *   1. Removes associated raw_transcripts rows
 *   2. Removes the audio_review_queue row
 *   3. Deletes the audio file from disk (processed/ dir first, then inbox root)
 *
 * This is a permanent, unrecoverable delete. The confirmation dialog in the UI
 * is the only safety net.
 */
router.delete('/api/review-queue/bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required and must not be empty' });
  }

  const results = { deleted: [], failed: [], filesRemoved: [] };
  const processedDir = path.join(AUDIO_INBOX, 'processed');

  for (const id of ids) {
    try {
      // Fetch item metadata before deletion so we can clean up the audio file.
      const item = getQueueItem(id);

      // Hard delete associated transcript data
      try {
        db.prepare('DELETE FROM raw_transcripts WHERE review_queue_id = ?').run(id);
      } catch (dbErr) {
        // Table may not exist or column name may differ — log and continue.
        log.warn({ id, error: dbErr.message }, 'Could not delete raw_transcripts row (non-fatal)');
      }

      // Hard delete the review queue row itself
      db.prepare('DELETE FROM audio_review_queue WHERE id = ?').run(id);

      // Remove audio file from disk if source_file is known
      if (item?.source_file) {
        for (const dir of [processedDir, AUDIO_INBOX]) {
          const filePath = path.join(dir, item.source_file);
          try {
            if (await fs.pathExists(filePath)) {
              await fs.remove(filePath);
              results.filesRemoved.push(item.source_file);
              break;
            }
          } catch (fileErr) {
            log.warn({ filePath, error: fileErr.message }, 'Could not remove audio file from disk (non-fatal)');
          }
        }
      }

      results.deleted.push(id);
    } catch (err) {
      log.error({ id, error: err.message }, 'Failed to hard delete queue item');
      results.failed.push({ id, error: err.message });
    }
  }

  log.info(
    { deleted: results.deleted.length, filesRemoved: results.filesRemoved.length, failed: results.failed.length },
    'Bulk hard delete completed'
  );

  res.json({ success: results.failed.length === 0, ...results });
});

/**
 * Render the review queue list page HTML.
 * Includes per-row checkboxes, Select All, and Delete Selected with confirmation.
 */
function renderReviewQueuePage(items, stats, { status, language, page, limit }) {
  const statusOptions = ['needs_review', 'reviewed', 'approved', 'archived', 'failed'];
  const languageOptions = ['en', 'hi', 'mixed-hi-en', 'unknown'];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conversation Review Queue — HYDRA</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #58a6ff; margin-bottom: 8px; }
    .subtitle { color: #8b949e; margin-bottom: 24px; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; min-width: 120px; }
    .stat-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; }
    .stat-card .value { font-size: 24px; font-weight: 600; color: #58a6ff; }
    .filters { display: flex; gap: 12px; margin-bottom: 24px; align-items: center; }
    select, input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
    .btn { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .btn:hover { background: #2ea043; }
    .btn-danger { background: #b91c1c; }
    .btn-danger:hover { background: #dc2626; }
    .bulk-toolbar { display: none; align-items: center; gap: 12px; margin-bottom: 16px; padding: 12px 16px;
      background: #1c2128; border: 1px solid #30363d; border-radius: 8px; }
    .bulk-toolbar.visible { display: flex; }
    .bulk-toolbar .selected-count { font-size: 14px; color: #c9d1d9; }
    .queue-table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    .queue-table th { background: #21262d; padding: 12px 16px; text-align: left; font-size: 12px; color: #8b949e; text-transform: uppercase; border-bottom: 1px solid #30363d; }
    .queue-table td { padding: 12px 16px; border-bottom: 1px solid #21262d; font-size: 14px; }
    .queue-table tr:hover { background: #1c2128; }
    .queue-table tr.selected-row { background: #112d4e; }
    .queue-table a { color: #58a6ff; text-decoration: none; }
    .queue-table a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-needs_review { background: #f0883e33; color: #f0883e; }
    .badge-reviewed { background: #58a6ff33; color: #58a6ff; }
    .badge-approved { background: #23863633; color: #3fb950; }
    .badge-archived { background: #8b949e33; color: #8b949e; }
    .badge-failed { background: #f8514933; color: #f85149; }
    .pagination { display: flex; gap: 8px; margin-top: 16px; justify-content: center; }
    .empty { text-align: center; padding: 48px; color: #8b949e; }
    input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #58a6ff; }
    /* Confirm dialog */
    .confirm-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 200;
      justify-content: center; align-items: center; }
    .confirm-overlay.open { display: flex; }
    .confirm-box { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px 32px;
      max-width: 420px; width: 90%; }
    .confirm-box h3 { color: #f85149; margin-bottom: 12px; }
    .confirm-box p { color: #8b949e; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
    .confirm-box .actions { display: flex; gap: 10px; justify-content: flex-end; }
    .btn-cancel { background: #21262d; }
    .btn-cancel:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎙️ Conversation Review Queue</h1>
    <p class="subtitle">Review, tag, and approve transcribed conversations before memory ingestion</p>

    <div class="stats">
      <div class="stat-card"><div class="label">Needs Review</div><div class="value">${stats.needs_review || 0}</div></div>
      <div class="stat-card"><div class="label">Reviewed</div><div class="value">${stats.reviewed || 0}</div></div>
      <div class="stat-card"><div class="label">Approved</div><div class="value">${stats.approved || 0}</div></div>
      <div class="stat-card"><div class="label">Total</div><div class="value">${stats.total || 0}</div></div>
    </div>

    <div class="filters">
      <label>Status:</label>
      <select onchange="window.location.search='?status='+this.value+'&language=${language || ''}'">
        <option value="">All</option>
        ${statusOptions.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
      </select>
      <label>Language:</label>
      <select onchange="window.location.search='?status=${status || ''}&language='+this.value">
        <option value="">All</option>
        ${languageOptions.map(l => `<option value="${l}" ${language === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <!-- Bulk action toolbar (visible when items are selected) -->
    <div class="bulk-toolbar" id="bulk-toolbar">
      <span class="selected-count" id="selected-count">0 selected</span>
      <button class="btn btn-danger" onclick="confirmBulkDelete()">&#x1F5D1; Delete Selected</button>
      <button class="btn btn-cancel" onclick="clearSelection()">Cancel</button>
    </div>

    ${items.length === 0 ? '<div class="empty">No items in queue matching filters.</div>' : `
    <table class="queue-table">
      <thead>
        <tr>
          <th><input type="checkbox" id="select-all" title="Select all" onchange="toggleSelectAll(this)"></th>
          <th>Source</th>
          <th>Summary</th>
          <th>Language</th>
          <th>Status</th>
          <th>Created</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="queue-tbody">
        ${items.map(item => `
        <tr id="row-${item.id}">
          <td><input type="checkbox" class="row-checkbox" value="${item.id}" onchange="onCheckboxChange()"></td>
          <td>${item.source_file || item.source || '—'}</td>
          <td>${(item.summary || '').substring(0, 80)}${(item.summary || '').length > 80 ? '…' : ''}</td>
          <td>${item.language || 'unknown'}</td>
          <td><span class="badge badge-${item.status}">${(item.status || '').replace('_', ' ')}</span></td>
          <td>${item.created_at || '—'}</td>
          <td><a href="/review/${item.id}">Review →</a></td>
        </tr>
        `).join('')}
      </tbody>
    </table>
    `}

    <div class="pagination">
      ${page > 1 ? `<a class="btn" href="?status=${status || ''}&language=${language || ''}&page=${page - 1}">← Previous</a>` : ''}
      <span style="padding: 8px; color: #8b949e;">Page ${page}</span>
      ${items.length === limit ? `<a class="btn" href="?status=${status || ''}&language=${language || ''}&page=${page + 1}">Next →</a>` : ''}
    </div>
  </div>

  <!-- Confirmation dialog -->
  <div class="confirm-overlay" id="confirm-overlay">
    <div class="confirm-box">
      <h3>⚠️ Permanently delete items?</h3>
      <p id="confirm-msg">This action cannot be undone. The selected items will be permanently removed from the database and the audio files will be deleted from disk.</p>
      <div class="actions">
        <button class="btn btn-cancel" onclick="closeConfirm()">Cancel</button>
        <button class="btn btn-danger" onclick="executeBulkDelete()">Delete Permanently</button>
      </div>
    </div>
  </div>

  <script>
    function getSelectedIds() {
      return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
    }

    function onCheckboxChange() {
      const ids = getSelectedIds();
      const toolbar = document.getElementById('bulk-toolbar');
      const countEl = document.getElementById('selected-count');
      const selectAll = document.getElementById('select-all');
      const allBoxes = document.querySelectorAll('.row-checkbox');

      countEl.textContent = ids.length + ' selected';
      toolbar.classList.toggle('visible', ids.length > 0);

      if (selectAll) {
        selectAll.indeterminate = ids.length > 0 && ids.length < allBoxes.length;
        selectAll.checked = ids.length === allBoxes.length && allBoxes.length > 0;
      }

      document.querySelectorAll('#queue-tbody tr').forEach(row => {
        const cb = row.querySelector('.row-checkbox');
        row.classList.toggle('selected-row', cb && cb.checked);
      });
    }

    function toggleSelectAll(masterCb) {
      document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = masterCb.checked; });
      onCheckboxChange();
    }

    function clearSelection() {
      document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = false; });
      const sa = document.getElementById('select-all');
      if (sa) { sa.checked = false; sa.indeterminate = false; }
      onCheckboxChange();
    }

    let pendingIds = [];

    function confirmBulkDelete() {
      pendingIds = getSelectedIds();
      if (pendingIds.length === 0) return;
      document.getElementById('confirm-msg').textContent =
        'Permanently delete ' + pendingIds.length + ' item(s)? This cannot be undone. ' +
        'The records will be removed from the database and audio files deleted from disk.';
      document.getElementById('confirm-overlay').classList.add('open');
    }

    function closeConfirm() {
      document.getElementById('confirm-overlay').classList.remove('open');
      pendingIds = [];
    }

    async function executeBulkDelete() {
      closeConfirm();
      if (pendingIds.length === 0) return;

      try {
        const res = await fetch('/review/api/review-queue/bulk', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: pendingIds }),
        });
        const data = await res.json();

        if (data.deleted && data.deleted.length > 0) {
          data.deleted.forEach(id => {
            const row = document.getElementById('row-' + id);
            if (row) row.remove();
          });
        }

        if (data.failed && data.failed.length > 0) {
          alert('Some items could not be deleted:\n' + data.failed.map(f => f.id + ': ' + f.error).join('\n'));
        }

        clearSelection();

        // Refresh page to update stats
        if (!data.failed || data.failed.length === 0) {
          setTimeout(() => location.reload(), 500);
        }
      } catch (err) {
        alert('Bulk delete failed: ' + err.message);
      }
    }

    // Close confirm on overlay click
    document.getElementById('confirm-overlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeConfirm();
    });
  </script>
</body>
</html>`;
}

export default router;
