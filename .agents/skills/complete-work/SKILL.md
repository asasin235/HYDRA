---
name: "complete-work"
description: "Complete HYDRA work by testing, syncing status to Notion and Linear, committing, and restarting affected agents."
---

1. Run `npm test` before marking the task complete.
2. If any test fails, fix the failures and rerun `npm test` until it passes.
3. Write a completion summary to the linked Notion page via the Notion MCP covering:
   - Changes made
   - Decisions taken
   - New environment variables, if any
4. Mark the related Linear issue as `In Review` via the Linear MCP.
5. Commit all relevant changes with a message that includes the Linear issue ID, for example `feat: add tool [HYD-123]`.
6. If any `agents/*.js` file was modified, restart the affected PM2 process with `pm2 restart <agent-name>`.
