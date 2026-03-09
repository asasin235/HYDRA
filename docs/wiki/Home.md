# 🐉 HYDRA — Personal AI Operating System

> **H**yper **Y**ielding **D**ecision & **R**esource **A**gent

HYDRA is a multi-agent AI system that manages Aatif Rashid's entire life — from work productivity and finances to health, relationships, home automation, investments, and freelance income. Built on Node.js, powered by multiple LLMs via OpenRouter, orchestrated through Slack, running on a Mac Mini with an external SSD for heavy data.

## 📚 Wiki Pages

| Page | Description |
|------|-------------|
| [[Architecture]] | System architecture, component diagram, data flows |
| [[Agent-Registry]] | All 14 agents — model, purpose, schedule |
| [[Core-Modules]] | Shared infrastructure modules in `core/` |
| [[Development-Guide]] | Setup, build, lint, run, and contribute |
| [[Scripts-and-Pipelines]] | Data pipeline scripts managed by PM2 |
| [[MCP-Server]] | MCP stdio server exposing HYDRA tools to external AI clients |
| [[Copilot-Instructions]] | GitHub Copilot coding agent instructions and conventions |

## 🚀 Quick Start

```sh
# 1. Clone and install
git clone https://github.com/asasin235/HYDRA.git
cd HYDRA
npm install

# 2. Configure environment
cp sample.env .env
# Edit .env with your API keys (see Development Guide)

# 3. Start all agents
npm start        # or: pm2 start ecosystem.config.cjs

# 4. View logs
pm2 logs
pm2 status
```

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 22 (ESM) |
| Host | Mac Mini (all agents run locally) |
| LLM Gateway | OpenRouter (Gemini 2.5, Claude Sonnet/Haiku, Mistral Small) |
| Process Manager | PM2 |
| Database | better-sqlite3 (WAL mode) |
| Vector Store | LanceDB |
| Chat Interface | Slack Bolt (Socket Mode) |
| Home Automation | Home Assistant REST API |
| Transcription | whisper.cpp (Apple Silicon Metal GPU) |
| Event Bus | Redis pub/sub via ioredis |
| Logging | Winston (JSON in PM2, pretty-print in dev) |
| Linting | ESLint (Node.js ESM flat config) |

## 🔗 Links

- [GitHub Repository](https://github.com/asasin235/HYDRA)
- [README](https://github.com/asasin235/HYDRA/blob/main/README.md)
- [Copilot Instructions](https://github.com/asasin235/HYDRA/blob/main/.github/copilot-instructions.md)
