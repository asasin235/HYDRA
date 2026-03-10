---
name: notion-docs
description: "Create and update documentation in the HYDRA Notion workspace. Use this skill when implementing features that need documentation, recording architecture decisions, updating API docs, or adding research findings."
---

# Notion Documentation for HYDRA

## Context
HYDRA documentation lives in a Notion workspace. All significant changes should be documented.

## When to Create/Update Docs

### Always Document
- New core modules (`core/*.js`) — API reference, usage examples
- New agents or agent capabilities — what it does, tools available, prompt strategy
- Schema changes (`core/db.js`) — table definitions, migration notes
- New environment variables — name, purpose, format, default value
- Architecture decisions — why this approach was chosen over alternatives
- New data pipelines — data flow diagram, trigger mechanism, output format

### Documentation Structure

#### Architecture Decision Records (ADRs)
```markdown
# ADR-{number}: {Title}

**Status:** Proposed | Accepted | Deprecated
**Date:** YYYY-MM-DD
**Context:** Why this decision is needed
**Decision:** What was decided
**Consequences:** What changes as a result
**Alternatives Considered:** What else was evaluated
```

#### Module Documentation
```markdown
# {Module Name}

## Purpose
One-sentence description.

## API
### functionName(param1, param2)
- **param1** (string): Description
- **Returns:** Description of return value

## Usage Example
\`\`\`js
import { functionName } from '../core/module.js';
const result = await functionName('value');
\`\`\`

## Configuration
| Env Var | Required | Default | Description |
|---------|----------|---------|-------------|

## Dependencies
- `core/db.js` — for persistent storage
- `core/logger.js` — for structured logging
```

#### Agent Documentation
```markdown
# {Agent Name} (XX-agentname)

## Role
What this agent does in the HYDRA ecosystem.

## Model & Tier
- **Model:** google/gemini-2.5-flash
- **Temperature:** 0.4
- **Tier:** 1 (always runs)

## Tools
| Tool | Description |
|------|-------------|

## Schedule
- Cron: `0 6 * * *` — morning brief
- Reactive: responds to Slack messages

## Context Query
What memory search terms this agent uses for context injection.
```

## Notion Pages to Keep Updated
- **HYDRA Overview** — high-level architecture, agent roster
- **Core Modules Reference** — API docs for each core/*.js module
- **Agent Playbook** — per-agent documentation
- **Data Pipelines** — pipeline architecture and data flows
- **Research Lab** — experimental findings, benchmarks
- **Changelog** — sprint-by-sprint progress log
- **Roadmap** — current improvement plan (sync with plan.md)
