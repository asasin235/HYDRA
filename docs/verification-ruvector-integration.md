# RuVector Integration — Verification Instructions

Step-by-step instructions for testing the RuVector integration on Mac Mini.

## Prerequisites

```bash
cd ~/Documents/HYDRA   # or wherever HYDRA is cloned
npm install            # installs ruvector + vitest + coverage
```

If `npm install` fails on `ruvector` (native Rust bindings), HYDRA will still work — the adapter fails silently and all operations continue on LanceDB only.

---

## 1. Run Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:ci

# Watch mode during development
npm run test:watch
```

Expected: All tests pass (registry, ruvectorStore, smoke).

---

## 2. Run Backfill (Phase 1)

Copies all existing LanceDB records into RuVector.

```bash
# Default paths (uses BRAIN_PATH from .env)
node scripts/backfill-lancedb-to-ruvector.js

# Custom paths
BRAIN_PATH=~/hydra-brain node scripts/backfill-lancedb-to-ruvector.js
```

**Expected output:**

```
═══════════════════════════════════════════════════════════════
 HYDRA — LanceDB → RuVector Backfill
═══════════════════════════════════════════════════════════════
  LanceDB path:  ./brain/lancedb
  RuVector path: ./brain/ruvector/ruvector.db

  📦 Processing table: memories
     Found 150 records
     Valid records (excl. init): 149
     ✅ Inserted: 149, ❌ Failed: 0
  ...
```

Each table shows insert/fail counts. Verify the RuVector DB file exists:

```bash
ls -la ~/hydra-brain/ruvector/ruvector.db
```

---

## 3. Enable Dual-Write (Phase 2)

Add to `.env`:

```env
RUVECTOR_ENABLE=1
RUVECTOR_DUAL_WRITE=1
```

Restart agents:

```bash
pm2 restart all
```

**Test:** Trigger any agent action that writes to memory (e.g., Architect daily plan). Then check that no errors appear in agent logs:

```bash
pm2 logs --lines 20 | grep ruvector
```

**Expected:** You should see `[memory] RuVector integration active` on startup. No error lines.

---

## 4. Enable Shadow Reads (Phase 3)

Add to `.env`:

```env
RUVECTOR_SHADOW_READ=1
```

Restart agents, then trigger a search (e.g., through the dashboard Memory page).

**Check metrics file:**

```bash
tail -5 ~/hydra-brain/ruvector/metrics.jsonl | python3 -m json.tool
```

Each line should contain:

- `lance_ms` / `ruv_ms` — latency comparison
- `lance_ids` / `ruv_ids` — returned IDs
- `overlap_ratio` — ID overlap between backends (0.0 to 1.0)

---

## 5. Check Dashboard Pages

Start the dashboard:

```bash
node scripts/dashboard.js
# or via PM2:
pm2 restart dashboard
```

Visit:

- **http://localhost:3080/ruvector** — RuVector Analysis (status, latency chart, recent queries, retry queue)
- **http://localhost:3080/lancedb** — LanceDB Analysis (table counts, doughnut chart, search test)

---

## 6. Test Retry Queue

Temporarily set an invalid storage path to force RuVector failures:

```env
RUVECTOR_STORAGE_PATH=/nonexistent/path/ruvector.db
```

Trigger a write, then check the retry queue:

```bash
cat ~/hydra-brain/ruvector/retry-queue.jsonl
```

To replay failures after fixing the path:

```bash
node scripts/replay-ruvector-retry-queue.js
```

---

## 7. Switch Reads to RuVector (Optional)

To make RuVector the primary read source:

```env
RUVECTOR_READ_PRIMARY=1
```

⚠️ Only do this after backfill is complete and shadow reads show high overlap ratios.

---

## Env Var Summary

| Variable                          | Default                          | Description                                |
| --------------------------------- | -------------------------------- | ------------------------------------------ |
| `RUVECTOR_ENABLE`                 | `0`                              | Master switch to load RuVector             |
| `RUVECTOR_DUAL_WRITE`             | `0`                              | Write to both stores                       |
| `RUVECTOR_SHADOW_READ`            | `0`                              | Run parallel shadow reads                  |
| `RUVECTOR_READ_PRIMARY`           | `0`                              | Return RuVector results instead of LanceDB |
| `RUVECTOR_STORAGE_PATH`           | `{BRAIN}/ruvector/ruvector.db`   | RuVector DB file                           |
| `RUVECTOR_METRICS_PATH`           | `{BRAIN}/ruvector/metrics.jsonl` | Metrics JSONL output                       |
| `RUVECTOR_SHADOW_TOPK_MULTIPLIER` | `3`                              | Fetch `limit*N` then post-filter           |

---

## File Locations

- **Metrics:** `{BRAIN_PATH}/ruvector/metrics.jsonl`
- **Retry queue:** `{BRAIN_PATH}/ruvector/retry-queue.jsonl`
- **RuVector DB:** `{BRAIN_PATH}/ruvector/ruvector.db`
- **Adapter code:** `core/ruvectorStore.js`
- **Backfill script:** `scripts/backfill-lancedb-to-ruvector.js`
- **Retry replay:** `scripts/replay-ruvector-retry-queue.js`
