---
name: linear-issues
description: "Create, update, and manage Linear issues for the HYDRA project. Use this skill when implementing features that need issue tracking, breaking down work into tasks, or updating issue status after completing work."
---

# Linear Issue Management for HYDRA

## Context
HYDRA uses Linear for issue tracking under the **Hydrajoker** team workspace.

## Projects
- `🐉 HYDRA Core Infrastructure` — core modules, config, infra
- `🎤 Audio Intelligence Pipeline` — Plaud sync, whisper, audio triage
- `🖥️ Screen Activity Pipeline` — screenpipe, screen sync
- `🧠 Vector Memory System` — LanceDB, RuVector, embeddings, memory search
- `💬 Slack Dashboard` — gateway, slash commands, briefs, dashboard
- `🤖 Agent Implementation` — individual agent features and tools
- `🔄 Proactive Intelligence` — proactive engine, workflows, automation
- `📊 Life Management` — goals, habits, CRM, decision journal

## Issue Format
When creating Linear issues, always include:

### Title
- Clear, action-oriented (e.g., "Build core/proactive.js scheduler engine")
- Prefix with verb: Build, Implement, Add, Fix, Refactor, Setup, Configure

### Description Structure
```markdown
Brief 1-2 sentence summary of what this implements and why.

**Requirements:**
* Bullet-pointed list of specific requirements
* Include API signatures where relevant
* Specify input/output formats

**Files:** `path/to/file1.js`, `path/to/file2.js`
**Dependencies:** module1, module2
**Env vars:** `VAR_NAME` (if new env vars needed)
```

### Labels
- `infra` — infrastructure, config, PM2, deployment
- `pipeline` — data pipelines, sync scripts, ingestion
- `ai` — LLM-related, prompts, agent intelligence
- `research` — investigation, A/B testing, benchmarking
- `security` — encryption, auth, access control
- `dashboard` — web UI, Express routes, charts
- `testing` — test suite, mocking, coverage

### Priority Levels
- `Urgent` — blocking other work, system broken
- `High` — important for next sprint, high impact
- `Medium` — planned work, moderate impact
- `Low` — nice to have, backlog

### Status Values
- `Backlog` — not yet planned
- `Todo` — planned for current/next sprint
- `In Progress` — actively being worked on
- `Done` — completed and verified

## Workflow
1. Before starting implementation, check if a Linear issue exists
2. If not, create one with the format above
3. Move to "In Progress" when starting work
4. Reference the issue ID (HYD-XX) in git commit messages
5. Move to "Done" when implementation is complete and tested
