# 🛠️ Development Guide

## Prerequisites

- **Node.js ≥ 22** (ESM required)
- **Redis** — for the event bus (`brew install redis && brew services start redis`)
- **PM2** — process manager (`npm install -g pm2`)
- **whisper.cpp** — for audio transcription (`/opt/homebrew/bin/whisper-cli`)
- A Mac Mini (Apple Silicon) is the intended host — most scripts are macOS-specific

## Initial Setup

```sh
# 1. Clone the repository
git clone https://github.com/asasin235/HYDRA.git
cd HYDRA

# 2. Install dependencies
npm install

# 3. Configure environment
cp sample.env .env
# Edit .env with your API keys — see Environment Variables section below
```

## Build & Validate

```sh
# Lint (always run before committing)
npm run lint

# Auto-fix lint issues
npm run lint:fix
```

> **There is no `npm test` command.** Validate changes by running the specific agent or script directly.

```sh
# Run an agent directly (Ctrl+C to stop)
node agents/XX-name.js

# Many scripts support a --test flag
node scripts/some-script.js --test

# One-shot mode for polling scripts
node scripts/sms-reader.js --once

# Test within PM2 (if running)
pm2 restart XX-name && pm2 logs XX-name
```

## Running Agents

```sh
npm start              # Start all agents via PM2
npm run dev            # Start MVP subset only
npm run stop           # Stop all PM2 processes
pm2 logs <agent-name>  # Tail specific agent logs
pm2 restart 01-edmobot # Restart a single agent
pm2 status             # View all process statuses
```

## Project Conventions

### ESM Only
`"type": "module"` in `package.json`. Use `import`/`export` everywhere. The only exceptions are `ecosystem.config.cjs` and `newrelic.cjs`.

### All LLM Calls Through OpenRouter
The `openai` SDK is configured with `baseURL: 'https://openrouter.ai/api/v1'`. Never call model providers (Anthropic, Google, etc.) directly.

### Error Handling
Errors are **non-fatal by default** — Redis down, LanceDB search failure, Slack post error → log warning and continue. Only missing env vars (`validateEnv`) are fatal.

### Agent Naming
- Files and PM2 names: `XX-name` (e.g. `05-jarvis`)
- Brain namespace: `XX_NAME` (e.g. `05_JARVIS`)
- Numbers `00-12` for agents, `99` for gateway

### Atomic Writes
`writeBrain` uses a temp file + rename pattern for crash safety.

### Bus Events Are Fire-and-Forget
Always `.catch(() => {})` on `publish()` calls.

## Commit Message Format

Every commit message must detail all changes made. Use a summary line + bullet list for multi-part changes:

```
feat(05-jarvis): add sleep mode tool, update prompt

- Add sleep_mode tool to agents/05-jarvis.js (turns off AC + dims lights)
- Update prompts/05-jarvis.txt with sleep mode instructions
- Wire 10PM cron for automatic sleep mode trigger
- Add HA_TOKEN env var to core/validate-env.js and sample.env
```

**Format:** `type(scope): description`

**Types:** `feat`, `fix`, `chore`, `refactor`, `docs`

## Environment Variables

All required variables are documented in `sample.env`. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | ✅ | LLM gateway (all agents) |
| `SLACK_BOT_TOKEN` | ✅ | Slack Bolt app token |
| `SLACK_APP_TOKEN` | ✅ | Slack Socket Mode token |
| `BRAIN_PATH` | ✅ | Absolute path to brain storage directory |
| `REDIS_URL` | 🔶 | Redis connection (default: `redis://localhost:6379`) |
| `HOME_ASSISTANT_URL` | 🔶 | HA instance URL (jarvis only) |
| `HOME_ASSISTANT_TOKEN` | 🔶 | HA long-lived access token (jarvis only) |
| `GITHUB_TOKEN` | 🔶 | Personal GitHub token (brandbot, edmobot) |
| `GITHUB_WORK_TOKEN` | 🔶 | Work GitHub token (edmobot) |
| `JIRA_URL` | 🔶 | Jira Cloud instance URL (edmobot) |
| `JIRA_EMAIL` | 🔶 | Jira account email (edmobot) |
| `JIRA_API_TOKEN` | 🔶 | Jira API token (edmobot) |
| `PERPLEXITY_API_KEY` | 🔶 | Perplexity Sonar API (wolf) |

See `core/validate-env.js` for the full per-agent list and `sample.env` for all variables.

## Adding a New Agent

See the [[Agent-Registry]] page for step-by-step instructions.

## Adding a New Core Module

1. Create `core/new-module.js` using ESM exports
2. Document all exported functions with JSDoc comments
3. Import in agents that need it — do **not** auto-import everywhere
4. Add any required env vars to `core/validate-env.js`
5. Update [[Core-Modules]] wiki page

## Adding a New Script/Pipeline

1. Create `scripts/new-script.js` using the poll-loop pattern (not cron)
2. Add `script('new-script', './scripts/new-script.js')` to `ecosystem.config.cjs`
3. Follow the pattern in `scripts/screenpipe-sync.js` for the simplest example
4. Update [[Scripts-and-Pipelines]] wiki page

## Dashboard

The token usage dashboard runs on port **3080**:

```sh
# Start dashboard only
pm2 start ecosystem.config.cjs --only dashboard

# Open in browser
open http://localhost:3080
```

Shows per-agent token usage, costs, health status, and logs.
