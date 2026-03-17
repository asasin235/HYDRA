/**
 * Dashboard Review Routes — Express router for the conversation review queue.
 * Provides list view, filtering, and queue management endpoints.
 * Mount on the main dashboard app: app.use('/review', reviewRouter)
 * @module scripts/dashboard-review-routes
 */
import { Router } from 'express';
import { listQueue, getQueueItem, updateQueueItem, getQueueStats } from '../core/review-queue-db.js';
import { getTranscriptByReviewQueueId } from '../core/transcript-store.js';
import { getClassificationByReviewQueueId } from '../core/interaction-classifier.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-review-routes');
const router = Router();

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
 * Render the review queue list page HTML.
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
    .queue-table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    .queue-table th { background: #21262d; padding: 12px 16px; text-align: left; font-size: 12px; color: #8b949e; text-transform: uppercase; border-bottom: 1px solid #30363d; }
    .queue-table td { padding: 12px 16px; border-bottom: 1px solid #21262d; font-size: 14px; }
    .queue-table tr:hover { background: #1c2128; }
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

    ${items.length === 0 ? '<div class="empty">No items in queue matching filters.</div>' : `
    <table class="queue-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Summary</th>
          <th>Language</th>
          <th>Status</th>
          <th>Created</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
        <tr>
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
</body>
</html>`;
}

export default router;
