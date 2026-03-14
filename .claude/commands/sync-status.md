---
name: sync-status
description: Audit open Hydrajoker issues against the current codebase and publish a Notion sync report
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
---

<objective>
Cross-check Linear issue state against the current HYDRA codebase and report drift to Notion.
</objective>

<process>
1. Fetch all open Linear issues for the Hydrajoker team via the Linear MCP.
2. For each issue, identify the relevant files, directories, or subsystems mentioned in the issue title, description, requirements, or attached context.
3. Cross-reference those areas against the current codebase and verify the implementation state directly.
4. Identify drift in both directions:
   - Work marked `Done` in Linear that is not actually implemented
   - Implemented behavior that has no corresponding open Linear issue
5. Write a status report to Notion under a page named `Sync Status` via the Notion MCP.
6. Structure the report so each issue includes current status, evidence from the codebase, and any drift that needs correction.
</process>
