/**
 * Dashboard Participant Tagging — Express routes for tagging speakers in review items.
 * Allows linking speaker labels to canonical people records and managing participants.
 * @module scripts/dashboard-participant-tagging
 */
import { Router } from 'express';
import { addParticipant, removeParticipant, listParticipantsByInteraction, updateParticipant } from '../core/interaction-participants-db.js';
import { getPerson, searchPeople } from '../core/people-db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-participant-tagging');
const router = Router();

/**
 * GET /review/api/participants/:reviewQueueId — List participants for a review item
 */
router.get('/api/participants/:reviewQueueId', (req, res) => {
  try {
    const participants = listParticipantsByInteraction(req.params.reviewQueueId);
    res.json({ participants });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to list participants');
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /review/api/participants/:reviewQueueId — Add a participant to a review item
 * Body: { speakerLabel, personId?, role? }
 */
router.post('/api/participants/:reviewQueueId', (req, res) => {
  try {
    const { speakerLabel, personId, role } = req.body;
    if (!speakerLabel) return res.status(400).json({ error: 'speakerLabel is required' });

    const id = addParticipant({
      interactionId: req.params.reviewQueueId,
      personId: personId || null,
      speakerLabel,
      role: role || 'participant',
    });

    log.info({ id, reviewQueueId: req.params.reviewQueueId, speakerLabel }, 'Participant added');
    res.json({ id, success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to add participant');
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /review/api/participants/:participantId — Update a participant (link to person, change role)
 * Body: { personId?, speakerLabel?, role? }
 */
router.put('/api/participants/:participantId', (req, res) => {
  try {
    const updated = updateParticipant(req.params.participantId, req.body);
    if (!updated) return res.status(404).json({ error: 'Participant not found' });
    res.json({ success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to update participant');
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /review/api/participants/:participantId — Remove a participant
 */
router.delete('/api/participants/:participantId', (req, res) => {
  try {
    const removed = removeParticipant(req.params.participantId);
    if (!removed) return res.status(404).json({ error: 'Participant not found' });
    res.json({ success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to remove participant');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /review/api/people/search?q=query — Search people for participant linking
 */
router.get('/api/people/search', (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.json({ people: [] });
    const people = searchPeople(q, Number(limit));
    res.json({ people });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to search people');
    res.status(500).json({ error: e.message });
  }
});

/**
 * Returns HTML fragment for the participant tagging widget.
 * Embeddable in the review detail page.
 */
export function renderParticipantTaggingWidget(reviewQueueId, participants) {
  return `
  <div id="participant-tagging" data-review-id="${reviewQueueId}">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h3 style="color: #f0f6fc; font-size: 14px; margin: 0;">👥 Participants</h3>
      <button class="btn btn-save" onclick="showAddParticipant()" style="font-size: 12px; padding: 4px 12px;">+ Add Speaker</button>
    </div>

    <div id="participants-list">
      ${participants.map(p => `
      <div class="participant-row" data-id="${p.id}" style="display: flex; gap: 8px; align-items: center; padding: 8px; background: #0d1117; border-radius: 6px; margin-bottom: 8px; border: 1px solid #21262d;">
        <span style="flex: 1; font-weight: 500;">${p.speaker_label || 'Unknown Speaker'}</span>
        <span style="color: #8b949e; font-size: 12px;">${p.person_id ? '✅ Linked' : '⚠️ Unlinked'}</span>
        <select onchange="linkPerson('${p.id}', this.value)" style="background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-size: 12px;">
          <option value="">Link to person…</option>
        </select>
        <button onclick="removeParticipantUI('${p.id}')" style="background: none; border: none; color: #f85149; cursor: pointer; font-size: 16px;">×</button>
      </div>
      `).join('')}
    </div>

    <div id="add-participant-form" style="display: none; margin-top: 12px; padding: 12px; background: #0d1117; border-radius: 6px; border: 1px solid #21262d;">
      <input id="new-speaker-label" type="text" placeholder="Speaker label (e.g. Speaker 1, John)" style="width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 4px; font-size: 14px; margin-bottom: 8px;" />
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-save" onclick="addParticipantUI()" style="font-size: 12px; padding: 4px 12px;">Add</button>
        <button class="btn btn-archive" onclick="hideAddParticipant()" style="font-size: 12px; padding: 4px 12px;">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    function showAddParticipant() { document.getElementById('add-participant-form').style.display = 'block'; }
    function hideAddParticipant() { document.getElementById('add-participant-form').style.display = 'none'; }

    async function addParticipantUI() {
      const label = document.getElementById('new-speaker-label').value.trim();
      if (!label) return;
      const reviewId = document.getElementById('participant-tagging').dataset.reviewId;
      await fetch('/review/api/participants/' + reviewId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerLabel: label }),
      });
      location.reload();
    }

    async function removeParticipantUI(id) {
      await fetch('/review/api/participants/' + id, { method: 'DELETE' });
      document.querySelector('[data-id="' + id + '"]')?.remove();
    }

    async function linkPerson(participantId, personId) {
      if (!personId) return;
      await fetch('/review/api/participants/' + participantId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId }),
      });
      location.reload();
    }
  </script>`;
}

export default router;
