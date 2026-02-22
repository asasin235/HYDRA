# HYDRA Screenpipe Sync

> Laptop-side daemon that captures your screen activity via Screenpipe, summarizes it with a local LLM (Ollama), and syncs to your HYDRA Mac Mini's shared brain.

## How It Works

```
Screenpipe (24/7)  →  Ollama (local LLM)  →  SSH  →  Mac Mini shared brain
 screen + audio        summarize every          Markdown files auto-indexed
 captures              15 minutes               by OpenClaw's memory search
```

## Prerequisites

### On your MacBook Pro:

1. **Screenpipe** — install from [screenpi.pe](https://screenpi.pe)
   ```bash
   brew install screenpipe
   # or download from https://screenpi.pe
   ```

2. **Ollama** — local LLM runtime
   ```bash
   brew install ollama
   ollama serve                    # start the server
   ollama pull qwen2.5:7b          # pull the model (~4GB)
   ```

3. **SSH key** for Mac Mini (passwordless)
   ```bash
   ssh-keygen -t ed25519           # if you don't have one
   ssh-copy-id hydra@192.168.68.100
   ```

4. **Node.js ≥ 22**

### On your Mac Mini:

- HYDRA running with OpenClaw gateway
- OpenClaw configured to index the shared context directory:
  ```bash
  openclaw config set agents.defaults.memorySearch.extraPaths '["~/hydra-brain/shared_context"]'
  ```

## Setup

```bash
cd hydra-screenpipe-sync

# Configure
cp .env.example .env
# Edit .env with your Mac Mini IP, SSH user, and preferences

# Test single run
node sync.js --once

# Run as daemon
node sync.js
# or with PM2:
pm2 start sync.js --name hydra-screenpipe-sync
```

## What Gets Synced

Every 15 minutes, the daemon:

1. Reads screen captures (OCR) and audio transcripts from Screenpipe's local API
2. Filters by relevant apps (Cursor, Chrome, Slack, etc.)
3. Summarizes via Ollama (Qwen 2.5 7B — runs locally, zero cost)
4. Writes a Markdown entry to the Mac Mini via SSH

The output looks like:

```markdown
## 14:30 — macbook-pro | Apps: Cursor, Chrome, Terminal

Working on HYDRA codebase in Cursor, implementing the OpenClaw memory bridge.
Researching Screenpipe API docs in Chrome. Running tests in Terminal.
```

These files are automatically indexed by OpenClaw and searchable by all HYDRA agents.

## Offline Resilience

If the Mac Mini is unreachable, summaries are buffered locally in `.buffer/` and will persist until the next successful sync.

## Cost

**$0** — Ollama runs locally on your M4 MacBook Pro (48GB is plenty for 7B models). No API calls needed.
