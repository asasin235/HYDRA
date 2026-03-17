/**
 * Dashboard People Routes — Express routes for inline person creation, search, and lightweight edit.
 * Covers HYD-51 (inline create), HYD-50 (search + edit), and people API endpoints.
 * @module scripts/dashboard-people-routes
 */
import { Router } from 'express';
import { createPerson, getPerson, updatePerson, searchPeople, listPeople } from '../core/people-db.js';
import { addIdentity, listIdentitiesByPerson } from '../core/person-identities-db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-people-routes');
const router = Router();

/**
 * POST /people/api/create — Inline person creation
 * Body: { displayName, aliases?, notes?, identities?: [{ platform, platformId, displayName? }] }
 */
router.post('/api/create', (req, res) => {
  try {
    const { displayName, aliases, notes, identities } = req.body;
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    const personId = createPerson({
      displayName: displayName.trim(),
      aliases: aliases || null,
      notes: notes || null,
    });

    // Add identities if provided
    if (identities && Array.isArray(identities)) {
      for (const identity of identities) {
        if (identity.platform && identity.platformId) {
          addIdentity({
            personId,
            platform: identity.platform,
            platformId: identity.platformId,
            displayName: identity.displayName || displayName,
          });
        }
      }
    }

    log.info({ personId, displayName }, 'Person created inline');
    res.json({ id: personId, displayName, success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to create person');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /people/api/search?q=query&limit=10 — Search people by name/alias
 */
router.get('/api/search', (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q || !q.trim()) return res.json({ people: [] });
    const people = searchPeople(q.trim(), Number(limit));
    res.json({ people });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to search people');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /people/api/:id — Get person details with identities
 */
router.get('/api/:id', (req, res) => {
  try {
    const person = getPerson(req.params.id);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    const identities = listIdentitiesByPerson(req.params.id);
    res.json({ person, identities });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to get person');
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /people/api/:id — Lightweight person edit
 * Body: { displayName?, aliases?, notes? }
 */
router.put('/api/:id', (req, res) => {
  try {
    const updated = updatePerson(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Person not found' });
    log.info({ id: req.params.id }, 'Person updated');
    res.json({ success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to update person');
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /people/api/:id/identity — Add identity to person
 * Body: { platform, platformId, displayName? }
 */
router.post('/api/:id/identity', (req, res) => {
  try {
    const { platform, platformId, displayName } = req.body;
    if (!platform || !platformId) return res.status(400).json({ error: 'platform and platformId required' });
    const id = addIdentity({
      personId: req.params.id,
      platform,
      platformId,
      displayName: displayName || null,
    });
    res.json({ id, success: true });
  } catch (e) {
    log.error({ error: e.message }, 'Failed to add identity');
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /people — People list page (HTML)
 */
router.get('/', (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const people = q ? searchPeople(q, Number(limit)) : listPeople({ limit: Number(limit), offset });

  res.send(renderPeopleListPage(people, { q, page: Number(page), limit: Number(limit) }));
});

function renderPeopleListPage(people, { q, page, limit }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>People — HYDRA</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { color: #58a6ff; margin-bottom: 16px; }
    .search-bar { display: flex; gap: 8px; margin-bottom: 24px; }
    input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; flex: 1; }
    .btn { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .btn:hover { background: #2ea043; }
    .btn-create { background: #1f6feb; }
    .btn-create:hover { background: #388bfd; }
    .people-list { list-style: none; }
    .people-list li { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    .people-list li:hover { border-color: #58a6ff; }
    .person-name { font-weight: 600; color: #f0f6fc; }
    .person-meta { font-size: 12px; color: #8b949e; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw; }
    .modal h2 { color: #f0f6fc; margin-bottom: 16px; font-size: 18px; }
    .modal input, .modal textarea { width: 100%; margin-bottom: 12px; }
    .modal textarea { min-height: 60px; resize: vertical; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 8px; border-radius: 6px; font-family: inherit; }
  </style>
</head>
<body>
  <div class="container">
    <h1>👥 People</h1>
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Search people..." value="${q || ''}" onkeydown="if(event.key==='Enter')searchPeople()" />
      <button class="btn" onclick="searchPeople()">Search</button>
      <button class="btn btn-create" onclick="showCreateModal()">+ New Person</button>
    </div>

    <ul class="people-list">
      ${people.map(p => `
      <li>
        <div>
          <div class="person-name">${p.display_name}</div>
          <div class="person-meta">${p.aliases || ''} · Created: ${p.created_at || ''}</div>
        </div>
        <a href="/people/api/${p.id}">View</a>
      </li>`).join('')}
      ${people.length === 0 ? '<li style="text-align: center; color: #8b949e;">No people found.</li>' : ''}
    </ul>
  </div>

  <div class="modal-overlay" id="create-modal" onclick="if(event.target===this)hideCreateModal()">
    <div class="modal">
      <h2>Create Person</h2>
      <input type="text" id="new-name" placeholder="Display name (required)" />
      <input type="text" id="new-aliases" placeholder="Aliases (comma separated)" />
      <textarea id="new-notes" placeholder="Notes (optional)"></textarea>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button class="btn" style="background: #21262d;" onclick="hideCreateModal()">Cancel</button>
        <button class="btn btn-create" onclick="createPersonUI()">Create</button>
      </div>
    </div>
  </div>

  <script>
    function searchPeople() {
      const q = document.getElementById('search-input').value;
      window.location.href = '/people?q=' + encodeURIComponent(q);
    }
    function showCreateModal() { document.getElementById('create-modal').style.display = 'flex'; }
    function hideCreateModal() { document.getElementById('create-modal').style.display = 'none'; }
    async function createPersonUI() {
      const displayName = document.getElementById('new-name').value.trim();
      if (!displayName) return alert('Name is required');
      const aliases = document.getElementById('new-aliases').value.trim() || null;
      const notes = document.getElementById('new-notes').value.trim() || null;
      const res = await fetch('/people/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, aliases, notes }),
      });
      const data = await res.json();
      if (data.success) { hideCreateModal(); location.reload(); }
      else alert(data.error || 'Failed to create person');
    }
  </script>
</body>
</html>`;
}

export default router;
