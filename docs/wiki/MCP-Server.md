# 🔌 MCP Server

HYDRA exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) stdio server that allows external AI clients (like OpenClaw) to interact with HYDRA's capabilities.

## Location

`mcp/hydra-mcp-server.js`

## How It Works

The MCP server is a **stdio-based server** — it's not managed by PM2. Instead, it's spawned on-demand by external AI clients.

```sh
# Register with OpenClaw
openclaw mcp add --name hydra --command "node mcp/hydra-mcp-server.js"
```

When an AI client needs to use a HYDRA tool, it spawns the MCP server process, communicates via stdin/stdout, and then the process exits.

## Available Tools

| Tool | Description |
|------|-------------|
| `hydra_home_control` | Control home devices via Home Assistant (AC, lights, geyser, etc.) |
| `hydra_read_sensors` | Read sensor data (temperature, humidity, motion, etc.) |
| `hydra_paper_trade` | Execute a paper trade (Wolf bot integration) |
| `hydra_portfolio` | Get current paper trading portfolio status |
| `hydra_debt_status` | Get debt payoff status (CFO bot integration) |
| `hydra_search_brain` | Semantic search across HYDRA's LanceDB vector memory |
| `hydra_write_context` | Write a note or context entry to shared brain |
| `hydra_agent_status` | Get health status of all HYDRA agents |
| `hydra_read_messages` | Read recent messages from any Hermes channel/contact |

## Adding a New MCP Tool

### Step 1: Add Tool Schema

In `mcp/hydra-mcp-server.js`, add to the `ListToolsRequestSchema` handler's `tools` array:

```js
{
  name: "hydra_new_tool",
  description: "What this tool does — be specific for the AI client",
  inputSchema: {
    type: "object",
    properties: {
      param: {
        type: "string",
        description: "Description of this parameter"
      }
    },
    required: ["param"]
  }
}
```

### Step 2: Add Handler

In the `CallToolRequestSchema` handler's `if/else` chain:

```js
else if (name === "hydra_new_tool") {
  const { param } = args;
  // ... implementation using core/ modules ...
  const result = `Done: ${param}`;
  return { content: [{ type: "text", text: result }] };
}
```

### Step 3: Import Dependencies

Add any needed `core/` module imports at the top of the file. The MCP server has full access to all HYDRA core modules.

## Testing the MCP Server

```sh
# Run directly (will wait for stdin input)
node mcp/hydra-mcp-server.js

# Test with a simple JSON-RPC call
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node mcp/hydra-mcp-server.js
```

## Architecture Notes

- The MCP server is **not** a long-running process — it's stateless and exits after each session
- It imports from `core/` directly, so it has the same access as any agent
- All core modules that require env vars must have those vars set in the shell that spawns the server
- Errors are returned as MCP error responses, not thrown exceptions
