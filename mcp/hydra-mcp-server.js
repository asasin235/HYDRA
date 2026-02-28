import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

// Calculate project root and load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

// Import HYDRA core modules
import { db, addTrade, getTrades, getDebt } from "../core/db.js";
import { writeContext } from "../core/openclaw-memory.js";
import { searchAllContext } from "../core/memory.js";
import { getMonthlySpend, isOpen, isPaused } from "../core/bottleneck.js";
import { ACTIVE_AGENT_NAMES } from "../core/registry.js";
import { getMessages } from "../core/hermes-bridge.js";

const HA_URL = process.env.HOME_ASSISTANT_URL || 'http://localhost:8123';
const HA_TOKEN = process.env.HOME_ASSISTANT_TOKEN || '';

function haHeaders() {
  return { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' };
}

const DEVICE_MAP = {
  ac: { domain: 'climate', entityId: process.env.HA_AC_ENTITY || 'climate.living_room_ac' },
  bedroom_lights: { domain: 'light', entityId: process.env.HA_BEDROOM_LIGHTS || 'light.bedroom' },
  desk_lamp: { domain: 'light', entityId: process.env.HA_DESK_LAMP || 'light.desk_lamp' }
};

const server = new Server({
  name: "hydra-mcp-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "hydra_home_control",
        description: "Control home devices (AC, lights, geyser) via Home Assistant API.",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "Device name (e.g., 'ac', 'bedroom_lights', 'desk_lamp')" },
            action: { type: "string", description: "Action to perform (e.g., 'turn_on', 'turn_off', 'set_temperature', 'dim')" },
            value: { type: "number", description: "Optional value (e.g., temperature in Celsius or brightness percentage)" }
          },
          required: ["device", "action"]
        }
      },
      {
        name: "hydra_read_sensors",
        description: "Read home motion, temperature, and door sensor states.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "hydra_paper_trade",
        description: "Execute a BUY or SELL paper trade for Nifty F&O.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Stock symbol" },
            action: { type: "string", description: "'buy' or 'sell'" },
            qty: { type: "number", description: "Quantity of shares" },
            price: { type: "number", description: "Price per share" }
          },
          required: ["symbol", "action", "qty", "price"]
        }
      },
      {
        name: "hydra_portfolio",
        description: "Get recent paper trading portfolio history and P&L.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of recent trades to retrieve" }
          },
          required: []
        }
      },
      {
        name: "hydra_debt_status",
        description: "Get current debt tracker status including total, paid, and remaining.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "hydra_search_brain",
        description: "Semantic search across shared brain (screen activity, audio transcripts, general notes).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language query" },
            limit: { type: "number", description: "Maximum number of results to retrieve" }
          },
          required: ["query"]
        }
      },
      {
        name: "hydra_write_context",
        description: "Write an observation, decision, or reminder to the shared brain notes.",
        inputSchema: {
          type: "object",
          properties: {
            source: { type: "string", description: "Source name (e.g., agent or user name)" },
            type: { type: "string", description: "Type of context (e.g., 'observation', 'decision', 'reminder')" },
            content: { type: "string", description: "The content text to save" }
          },
          required: ["source", "type", "content"]
        }
      },
      {
        name: "hydra_agent_status",
        description: "Get health, current budget usage, and circuit breaker status for all HYDRA agents.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "hydra_read_messages",
        description: "Read recent messages from a specific channel and contact via OpenClaw Gateway.",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel name (e.g., 'whatsapp', 'telegram', 'imessage', 'discord')" },
            contact: { type: "string", description: "Contact phone number, chat ID, or target name" },
            limit: { type: "number", description: "Number of recent messages to retrieve (max 50, default 10)" }
          },
          required: ["channel", "contact"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "hydra_home_control") {
      const { device, action, value } = args;
      const d = DEVICE_MAP[device];
      if (!d) return { toolResult: `Unknown device: ${device}` };

      let service, payload;
      if (d.domain === 'climate') {
        if (action === 'set_temperature') {
          service = 'set_temperature';
          payload = { entity_id: d.entityId, temperature: value };
        } else if (action === 'turn_off') {
          service = 'turn_off';
          payload = { entity_id: d.entityId };
        } else {
          service = action;
          payload = { entity_id: d.entityId, ...(value !== undefined ? { temperature: value } : {}) };
        }
      } else {
        if (action === 'dim') {
          service = 'turn_on';
          payload = { entity_id: d.entityId, brightness_pct: Number(value) };
        } else {
          service = action;
          payload = { entity_id: d.entityId };
        }
      }

      await axios.post(`${HA_URL}/api/services/${d.domain}/${service}`, payload, { headers: haHeaders() });
      const resultMsg = `OK: ${device} → ${action}${value !== undefined ? ` (${value})` : ''}`;
      return { content: [{ type: "text", text: resultMsg }] };
    }

    else if (name === "hydra_read_sensors") {
      const res = await axios.get(`${HA_URL}/api/states`, { headers: haHeaders() });
      const states = res.data;
      const relevant = {};
      const ENTITIES = [
        process.env.HA_MOTION_SENSOR || 'binary_sensor.aqara_motion_p1',
        process.env.HA_TEMP_SENSOR || 'sensor.tapo_t310_temperature',
        process.env.HA_DOOR_SENSOR || 'binary_sensor.door_sensor'
      ];
      for (const s of states) {
        if (ENTITIES.includes(s.entity_id)) {
          // parse state and name for easier reading
          const name = s.attributes.friendly_name || s.entity_id;
          relevant[name] = { state: s.state, last_changed: s.last_changed };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(relevant, null, 2) }] };
    }

    else if (name === "hydra_paper_trade") {
      const { symbol, action, qty, price } = args;
      const normalizedAction = String(action).toLowerCase();
      if (normalizedAction !== "buy" && normalizedAction !== "sell") {
        return {
          content: [{
            type: "text",
            text: `Invalid action "${action}". Allowed actions are "buy" or "sell".`
          }],
          isError: true
        };
      }
      addTrade(symbol, normalizedAction, qty, price, 0); // initial PNL 0
      return {
        content: [{
          type: "text",
          text: `Trade executed: ${normalizedAction.toUpperCase()} ${qty}x ${symbol} @ ₹${price}`
        }]
      };
    }

    else if (name === "hydra_portfolio") {
      const { limit = 10 } = args;
      const trades = getTrades(limit);
      return { content: [{ type: "text", text: JSON.stringify(trades, null, 2) }] };
    }

    else if (name === "hydra_debt_status") {
      const debtData = getDebt();
      if (!debtData) {
        return { content: [{ type: "text", text: "Debt tracker uninitialized." }] };
      }
      const remaining = debtData.debt - debtData.paid;
      const pct = debtData.debt > 0 ? ((debtData.paid / debtData.debt) * 100).toFixed(1) : 0;
      const text = `₹${remaining.toLocaleString()} remaining, ₹${debtData.paid.toLocaleString()} paid (${pct}%)\nTotal debt: ₹${debtData.debt.toLocaleString()}\nWedding Fund: ₹${debtData.wedding_fund.toLocaleString()}\nLast Updated: ${debtData.updated_at}`;
      return { content: [{ type: "text", text }] };
    }

    else if (name === "hydra_search_brain") {
      const { query, limit = 5 } = args;
      const results = await searchAllContext(query, { limit });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    else if (name === "hydra_write_context") {
      const { source, type, content } = args;
      await writeContext(source, type, content);
      return { content: [{ type: "text", text: `Successfully wrote context of type [${type}] from ${source}.` }] };
    }

    else if (name === "hydra_agent_status") {
      const spend = await getMonthlySpend();
      const statusList = [];
      const now = new Date();

      for (const agent of ACTIVE_AGENT_NAMES) {
        const paused = await isPaused(agent);
        const open = isOpen(agent);

        let state = "healthy";
        if (open) state = "circuit-open (failing)";
        else if (paused) state = "paused (budget exceeded)";

        const cost = spend.perAgent[agent]?.cost || 0;
        const tokens = spend.perAgent[agent]?.tokens || 0;

        statusList.push({
          agent,
          status: state,
          monthly_cost_usd: cost.toFixed(4),
          monthly_tokens: tokens
        });
      }

      const summary = {
        total_monthly_spend: `$${spend.total.toFixed(4)}`,
        budget_remaining: `$${spend.remaining.toFixed(4)}`,
        agents: statusList
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    else if (name === "hydra_read_messages") {
      let { channel, contact, limit = 10 } = args;
      if (limit > 50) limit = 50;
      const messages = await getMessages(channel, contact, limit);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }

    else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
      isError: true
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HYDRA MCP Server running on stdio"); // Ensure logging uses stderr
}

run().catch((error) => {
  console.error("Failed to start HYDRA MCP server:", error);
  process.exit(1);
});
