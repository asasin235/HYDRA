# HYDRA Dashboard — Future Improvements

> Ideas and planned enhancements for the HYDRA Neural Dashboard.
> The brain never stops evolving — cut off one head, two more shall take its place.

---

## High Priority

### 1. Change LLM Model from Dashboard

**Current:** Model assignments are hardcoded in `core/registry.js` and require a code change + PM2 restart.

**Proposed:** Add a dropdown on each agent's detail page to select from available models (filtered by tier/cost). On save, update the registry config in memory and restart the agent via PM2.

**Considerations:**
- Must enforce tier-based budget limits (Tier 3 agents shouldn't use Opus)
- Should show estimated cost-per-1K-tokens for each model option
- Changes could be persisted to a `brain/dashboard/overrides.json` that `core/registry.js` reads on startup

---

### 2. Agent Stop / Start Controls

**Current:** Only restart is available from dashboard.

**Proposed:** Add stop and start buttons alongside restart. Show a clear visual state for stopped agents (greyed out card, red border).

---

### 3. Real-Time Log Streaming

**Current:** Logs are polled every 60 seconds from SQLite.

**Proposed:** Add WebSocket support (`ws` package) for real-time log streaming. The dashboard would maintain a persistent connection and receive new log entries as they're written.

---

### 4. Token Usage Charts

**Current:** Only raw numbers are shown for token usage.

**Proposed:** Add daily/weekly/monthly spend charts per agent using Chart.js or a lightweight charting library. Show:
- Stacked bar chart of daily spend across all agents
- Individual agent trend lines
- Budget burn-down chart with projected exhaustion date

---

### 5. Agent Configuration Editor

**Current:** All agent config (temperature, contextQuery, maxHistoryTurns) requires editing `core/registry.js`.

**Proposed:** Provide a settings panel per agent page where temperature, max history turns, and context query can be edited live. Changes saved to an override file, applied on next agent restart.

---

## Medium Priority

### 6. Prompt Editor

**Proposed:** In-browser editor for system prompt files (`prompts/*.txt`). Show current prompt with syntax highlighting, allow edits, and save directly. Include version history (show last 5 git commits for each prompt file).

---

### 7. Memory / Brain Browser

**Proposed:** Query and browse LanceDB vector memories from the dashboard. Search by text, filter by agent namespace, view embeddings in a 2D projection (t-SNE or UMAP visualization).

---

### 8. Budget Alerts & Notifications

**Proposed:** Configure budget thresholds (60%, 80%, 90%) with browser push notifications. Show a budget alert banner when approaching limits.

---

### 9. Conversation History Viewer

**Proposed:** Browse and search conversation history from SQLite `conversation_history` table. Filter by agent, date range, and keyword. Useful for debugging agent behavior.

---

### 10. Mobile-Optimized View

**Current:** Dashboard has basic responsive CSS but no mobile-first layout.

**Proposed:** Add a bottom navigation bar for mobile, collapsible sidebar, and touch-optimized agent cards. Consider a PWA manifest for home screen installation.

---

## Low Priority / Backlog

### 11. Dark/Light Theme Toggle

**Proposed:** Add a theme switcher. The current Zola neural theme is dark — offer a light "clinical" mode for daytime use.

---

### 12. Agent Dependency Graph

**Proposed:** Visual graph showing how agents interact (via Redis bus events, shared data). Helps understand information flow across the HYDRA network.

---

### 13. Scheduled Task Calendar

**Proposed:** Visual calendar showing when each agent's cron jobs fire. Helps identify scheduling conflicts and idle periods.

---

### 14. Export & Reporting

**Proposed:** Export usage data as CSV/JSON. Generate weekly/monthly PDF reports with spend breakdowns, agent performance metrics, and recommendations.

---

### 15. Multi-User Access Control

**Current:** Single hardcoded username/password.

**Proposed:** Add role-based access (admin: full control, viewer: read-only). Store credentials in SQLite with bcrypt hashing. Add session expiry and audit logging.

---

### 16. Integration Status Panel

**Proposed:** Show connection status for all external services:
- Slack (Socket Mode connection)
- Redis (pub/sub health)
- OpenRouter (API reachability)
- LanceDB (vector store status)
- Hermes Gateway (WhatsApp/Telegram/Discord bridge)

---

## Implementation Notes

- All dashboard changes should remain in `scripts/dashboard.js` as a single-file Express server
- External assets (fonts, icons) should use CDN links — no build step
- New features should be behind API endpoints that can be reused by MCP tools
- Follow the existing pattern: server-rendered HTML with client-side fetch for data

---

*Last updated: 2026-02-28*
