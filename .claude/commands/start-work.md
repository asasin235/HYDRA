---
name: start-work
description: Fetch the current Hydrajoker issue context and produce a pre-code plan
allowed-tools:
  - Read
  - Bash
---

<objective>
Start work from the current Hydrajoker Linear issue and any linked Notion context before making code changes.
</objective>

<process>
1. Fetch the current `In Progress` issue from the Hydrajoker team via the Linear MCP.
2. Read the issue description, requirements, and acceptance criteria in full.
3. If the issue includes a linked Notion URL, fetch that document via the Notion MCP and extract implementation constraints or architecture notes.
4. Produce a structured pre-code plan with these sections:
   - Goal
   - Affected files
   - Approach
   - Risks
   - Acceptance criteria
5. Do not write or modify code until that plan is complete.
</process>
