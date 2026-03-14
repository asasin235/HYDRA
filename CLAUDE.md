# HYDRA Project Memory

HYDRA is a multi-agent AI personal operating system running on Node.js and PM2, with Slack as the main interaction surface, Redis pub/sub for internal events, OpenRouter for LLM calls, SQLite for structured persistence, and LanceDB for vector memory.

## Important project facts
- `core/registry.js` is the source of truth for agent config.
- `core/agent.js` is shared infrastructure for LLM-based agents.
- `core/db.js` owns SQLite schema and access helpers.
- `core/memory.js` owns vector memory behavior.
- `core/bus.js` owns Redis channel behavior.
- `ecosystem.config.cjs` owns PM2 process definitions.
- `mcp/hydra-mcp-server.js` is the internal stdio MCP server for HYDRA tools.

## How to work in this repo
- Read nearby code before editing.
- Prefer minimal, targeted diffs.
- Do not duplicate shared logic that belongs in `core/`.
- Do not hardcode agent metadata outside `core/registry.js`.
- Keep prompts concise and non-repetitive.
- Preserve structured logging, retries, graceful shutdown, and budget-aware behavior.
- Use existing OpenRouter integration patterns for all LLM work.
- Treat most dependency failures as non-fatal unless the codebase already treats them as fatal.

## Skill routing
- Use `hydra-agent-dev` for code changes to agents, prompts, tools, core modules, schemas, pipelines, PM2 config, or MCP tools.
- Use `linear-issues` for work planning, issue checks, issue creation, status changes, and completion workflows.
- Use `notion-docs` for architecture docs, runbooks, decision logs, prompt logs, module docs, and documentation updates tied to meaningful structural changes.

## Development workflow
- Test end-to-end before finishing.
- Mention touched files explicitly.
- Call out risk when editing shared infrastructure.
- Keep commit intent concrete and implementation-friendly.
- Ensure docs and tracking stay aligned with major code changes.

## AI Workflow Rules
- Before starting any task, always fetch the current In Progress Linear issue from the Hydrajoker team via the Linear MCP.
- After completing any task, write a summary of changes to the linked Notion page via the Notion MCP, then mark the Linear issue as In Review.
- Always run `npm test` before marking work complete. Fix failures before proceeding.
- Commit messages must reference the Linear issue ID (for example `feat: add tool [HYD-123]`).
