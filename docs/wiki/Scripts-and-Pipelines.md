# ⚙️ Scripts & Data Pipelines

All scripts run as persistent PM2 processes (defined via `script()` in `ecosystem.config.cjs`). They use a **poll-loop pattern** rather than cron — `setInterval` or a loop with `await sleep()`.

## Script Summary

| Script | Purpose | Poll Interval | Data Flow |
|--------|---------|--------------|-----------|
| `plaud-sync.js` | Syncs Plaud Note Pro recordings, transcribes, summarises, ingests | 30min (API) / 1min (watch) | Plaud API or `audio_inbox/` → whisper.cpp → LanceDB |
| `ingest-audio.js` | Watches `audio_inbox/` for raw audio, transcribes and summarises | 60s | `audio_inbox/*.mp3` → whisper.cpp → `shared_context/audio/` |
| `screenpipe-sync.js` | Ingests screen Markdown into LanceDB, tracks byte offset | 5min | `shared_context/screen/*.md` → LanceDB `screen_activity` |
| `ingest-context.js` | Unified watcher for screen + audio → LanceDB with embeddings | 5min | `shared_context/{screen,audio}/*.md` → LanceDB |
| `sms-reader.js` | Reads macOS Messages `chat.db` → parses bank SMS → SQLite | 5min | `~/Library/Messages/chat.db` → `hydra.db` transactions |
| `dashboard.js` | Express dashboard (port 3080) showing usage, costs, health | Always-on | `brain/usage/` JSON → HTTP |

## `scripts/plaud-sync.js` — Audio Transcription Pipeline

Syncs recordings from the Plaud Note Pro and transcribes them locally.

**Two modes:**
1. **API mode** (every 30min): polls Plaud REST API for new recordings, downloads MP3s
2. **Watch mode** (every 1min): watches `audio_inbox/` directory for MP3 files placed there manually

**Pipeline:**
```
Plaud API / audio_inbox/
  → download MP3
  → whisper.cpp transcription (Apple Silicon Metal GPU)
  → OpenRouter summarisation (Claude Sonnet)
  → Markdown to shared_context/audio/
  → LanceDB ingestion
```

**Environment variables required:** `PLAUD_API_KEY`, `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`, `OPENROUTER_API_KEY`

## `scripts/ingest-audio.js` — Local-Only Audio Ingestion

Watches `audio_inbox/` for raw audio files and transcribes them without using OpenRouter.

**Pipeline:**
```
audio_inbox/*.mp3
  → whisper.cpp transcription (local, no API)
  → Ollama summarisation (gemma3:4b, local, no API)
  → Markdown to shared_context/audio/
```

**Environment variables required:** `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`
**Optional:** `OLLAMA_URL`, `OLLAMA_MODEL`

## `scripts/screenpipe-sync.js` — Screen Context Ingestion

Ingests daily Markdown files written by the MacBook-side Screenpipe sync daemon into LanceDB. Tracks a byte offset per date to avoid re-ingesting content already processed.

**Pipeline:**
```
MacBook Pro (Screenpipe + sync daemon)
  → SSH → shared_context/screen/YYYY-MM-DD.md
  → screenpipe-sync.js reads new content (byte-offset tracking)
  → embed via OpenRouter text-embedding-3-small
  → LanceDB screen_activity table
```

## `scripts/ingest-context.js` — Unified Context Watcher

A superset of `screenpipe-sync.js` — watches both screen and audio Markdown and ingests both into LanceDB.

## `scripts/sms-reader.js` — Bank SMS Parser

Reads the macOS Messages database and parses Indian bank SMS to extract transactions.

**Requirements:**
- **Full Disk Access** must be granted to Terminal.app in System Settings → Privacy & Security
- Dates in `chat.db` use the Core Data epoch (nanoseconds since 2001-01-01)

**Pipeline:**
```
~/Library/Messages/chat.db
  → filter bank SMS (HDFC, SBI, ICICI, etc.)
  → regex parse amount, merchant, category
  → SQLite transactions table
  → brain/06_CFO/sms_inbox.json (for CFO bot)
```

**One-shot mode:** `node scripts/sms-reader.js --once`

## `scripts/dashboard.js` — Token Usage Dashboard

Express server running on port **3080** with:
- Per-agent token usage charts (doughnut + bar via Chart.js)
- Monthly cost tracking
- Agent health status
- Filterable log viewer
- System health section (watchtower monitoring, heartbeats)

```sh
open http://localhost:3080
```

## Adding a New Script

1. Create `scripts/new-script.js`
2. Use the poll-loop pattern:
   ```js
   import { createLogger } from '../core/logger.js';
   const log = createLogger('new-script');

   async function run() {
     log.info('Starting new-script');
     while (true) {
       try {
         await doWork();
       } catch (err) {
         log.warn('Error in new-script', { error: err.message });
       }
       await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // 5min
     }
   }

   run();
   ```
3. Register in `ecosystem.config.cjs`:
   ```js
   script('new-script', './scripts/new-script.js'),
   ```
4. Start: `pm2 start ecosystem.config.cjs --only new-script`
