/**
 * Dashboard Sensitivity & Retention Controls — Express routes for overriding
 * sensitivity levels and retention classes during human review.
 * @module scripts/dashboard-sensitivity-controls
 */
import { Router } from 'express';
import { humanOverride, getClassificationByReviewQueueId, VALID_SENSITIVITY } from '../core/interaction-classifier.js';
import { applyRetentionPolicy, VALID_RETENTION } from '../core/retention-engine.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-sensitivity-controls');
const router = Router();

/**
 * PUT /review/api/sensitivity/:classificationId — Override sensitivity level
 * Body: { sensitivity, notes? }
 */
router.put('/api/sensitivity/:classificationId', (req, res) => {
  try {
    const { sensitivity, notes } = req.body;
    if (!VALID_SENSITIVITY.includes(sensitivity)) {
      return res.status(400).json({ error: `Invalid sensitivity. Valid: ${VALID_SENSITIVITY.join(', ')}` });
    }
    const updated = humanOverride(req.params.classificationId, {
      sensitivity, reviewer: 'dashboard-user', notes: notes || `Sensitivity set to ${sensitivity}`,
    });
    if (!updated) return res.status(404).json({ error: 'Classification not found' });
    log.info({ classificationId: req.params.classificationId, sensitivity }, 'Sensitivity override applied');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /review/api/retention/:interactionId — Override retention class
 * Body: { retentionClass }
 */
router.put('/api/retention/:interactionId', (req, res) => {
  try {
    const { retentionClass } = req.body;
    if (!VALID_RETENTION.includes(retentionClass)) {
      return res.status(400).json({ error: `Invalid retention class. Valid: ${VALID_RETENTION.join(', ')}` });
    }
    const result = applyRetentionPolicy(req.params.interactionId, { manualOverride: retentionClass });
    if (!result) return res.status(404).json({ error: 'Interaction not found' });
    log.info({ interactionId: req.params.interactionId, retentionClass }, 'Retention override applied');
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /review/api/sensitivity-options — List valid sensitivity and retention options
 */
router.get('/api/sensitivity-options', (req, res) => {
  res.json({ sensitivity: VALID_SENSITIVITY, retention: VALID_RETENTION });
});

/**
 * Returns HTML fragment for sensitivity and retention controls.
 */
export function renderSensitivityRetentionControls(classification, interaction) {
  const sens = classification?.sensitivity || 'low';
  const retention = interaction?.retention_class || 'context';
  const classId = classification?.id || '';
  const interactionId = interaction?.id || '';

  return `
  <div id="sensitivity-retention-controls" style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
    <div>
      <label style="font-size: 12px; color: #8b949e; text-transform: uppercase;">Sensitivity</label>
      <select id="override-sensitivity" style="width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 6px; margin-top: 4px;">
        ${VALID_SENSITIVITY.map(s => `<option value="${s}" ${s === sens ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <button onclick="applySensitivity('${classId}')" style="margin-top: 8px; background: #1f6feb; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Set Sensitivity</button>
    </div>
    <div>
      <label style="font-size: 12px; color: #8b949e; text-transform: uppercase;">Retention Policy</label>
      <select id="override-retention" style="width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 6px; margin-top: 4px;">
        ${VALID_RETENTION.map(r => `<option value="${r}" ${r === retention ? 'selected' : ''}>${r.replace('_', ' ')}</option>`).join('')}
      </select>
      <button onclick="applyRetention('${interactionId}')" style="margin-top: 8px; background: #1f6feb; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Set Retention</button>
    </div>
  </div>
  <script>
    async function applySensitivity(classId) {
      if (!classId) return;
      const val = document.getElementById('override-sensitivity').value;
      await fetch('/review/api/sensitivity/' + classId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sensitivity: val }),
      });
      location.reload();
    }
    async function applyRetention(interactionId) {
      if (!interactionId) return;
      const val = document.getElementById('override-retention').value;
      await fetch('/review/api/retention/' + interactionId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionClass: val }),
      });
      location.reload();
    }
  </script>`;
}

export default router;
