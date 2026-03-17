/**
 * Dashboard Classification Controls — Express routes for relationship/domain override UI.
 * Allows human reviewers to override auto-classified relationship and domain values.
 * @module scripts/dashboard-classification-controls
 */
import { Router } from 'express';
import { humanOverride, getClassificationByReviewQueueId, autoClassify, VALID_RELATIONSHIP_TYPES, VALID_DOMAINS, VALID_SENSITIVITY } from '../core/interaction-classifier.js';
import { resolveHeuristics } from '../core/heuristic-resolver.js';
import { getTranscriptByReviewQueueId } from '../core/transcript-store.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-classification-controls');
const router = Router();

/**
 * GET /review/api/classification/:reviewQueueId — Get current classification
 */
router.get('/api/classification/:reviewQueueId', (req, res) => {
  try {
    const classification = getClassificationByReviewQueueId(req.params.reviewQueueId);
    res.json({
      classification,
      options: { relationshipTypes: VALID_RELATIONSHIP_TYPES, domains: VALID_DOMAINS, sensitivity: VALID_SENSITIVITY },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /review/api/classification/:reviewQueueId/auto — Run auto-classification
 */
router.post('/api/classification/:reviewQueueId/auto', (req, res) => {
  try {
    const transcript = getTranscriptByReviewQueueId(req.params.reviewQueueId);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found' });

    const heuristics = resolveHeuristics(transcript.raw_transcript);
    const id = autoClassify({
      reviewQueueId: req.params.reviewQueueId,
      relationshipType: heuristics.relationship,
      domain: heuristics.domain,
      sensitivity: 'low',
      topics: [],
      confidence: heuristics.confidence,
    });

    log.info({ id, reviewQueueId: req.params.reviewQueueId }, 'Auto-classification run');
    res.json({ id, ...heuristics, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /review/api/classification/:classificationId/override — Human override
 * Body: { relationshipType?, domain?, sensitivity?, topics?, notes? }
 */
router.put('/api/classification/:classificationId/override', (req, res) => {
  try {
    const { relationshipType, domain, sensitivity, topics, notes } = req.body;
    const updated = humanOverride(req.params.classificationId, {
      relationshipType, domain, sensitivity, topics, reviewer: 'dashboard-user', notes,
    });
    if (!updated) return res.status(404).json({ error: 'Classification not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Returns HTML fragment for classification override controls.
 */
export function renderClassificationControls(classification) {
  const relType = classification?.relationship_type || 'unknown';
  const domain = classification?.domain || 'unknown';
  const sens = classification?.sensitivity || 'low';
  const classId = classification?.id || '';

  return `
  <div id="classification-controls" data-classification-id="${classId}">
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div>
        <label style="font-size: 12px; color: #8b949e; text-transform: uppercase;">Relationship Type</label>
        <select id="override-rel" style="width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 6px; margin-top: 4px;">
          ${VALID_RELATIONSHIP_TYPES.map(r => `<option value="${r}" ${r === relType ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="font-size: 12px; color: #8b949e; text-transform: uppercase;">Domain</label>
        <select id="override-domain" style="width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 6px; margin-top: 4px;">
          ${VALID_DOMAINS.map(d => `<option value="${d}" ${d === domain ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="margin-top: 12px;">
      <button class="btn btn-save" onclick="applyClassificationOverride()" style="font-size: 12px;">Apply Override</button>
      <span style="margin-left: 8px; font-size: 12px; color: #8b949e;">${classification?.human_override ? '✅ Human override active' : '🤖 Auto-classified'}</span>
    </div>
  </div>
  <script>
    async function applyClassificationOverride() {
      const classId = document.getElementById('classification-controls').dataset.classificationId;
      if (!classId) return alert('No classification to override');
      const rel = document.getElementById('override-rel').value;
      const dom = document.getElementById('override-domain').value;
      await fetch('/review/api/classification/' + classId + '/override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationshipType: rel, domain: dom }),
      });
      location.reload();
    }
  </script>`;
}

export default router;
