---
name: "debug-issue"
description: "Debug HYDRA issues by tracing the core agent execution path, fixing the root cause, validating with tests, and logging the result to Linear."
---

1. Read the reported error in full, including stack traces, logs, and reproduction details if present.
2. Trace the HYDRA call chain from `core/agent.js` through tool execution, the Redis bus layer, and the database layer to identify the actual root cause.
3. Implement the fix instead of applying a symptom-only workaround.
4. Run `npm test` to confirm the issue is resolved.
5. Add a Linear comment via the Linear MCP summarizing the root cause, the fix, and the validation performed.
