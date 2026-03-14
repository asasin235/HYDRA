---
name: "start-work"
description: "Start HYDRA work from the current Hydrajoker Linear issue and linked Notion context."
---

1. Fetch the current `In Progress` issue from the Hydrajoker team via the Linear MCP before making any code changes.
2. Read the Linear issue description, requirements, and acceptance criteria in full.
3. If the issue includes a linked Notion URL, fetch that document via the Notion MCP and extract any implementation constraints or architecture notes.
4. Produce a structured pre-code plan with these sections:
   - Goal
   - Affected files
   - Approach
   - Risks
   - Acceptance criteria
5. Do not write or modify code until that plan is complete.
