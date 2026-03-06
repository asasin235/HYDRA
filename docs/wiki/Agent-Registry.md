# 🤖 Agent Registry

All agent configuration lives in [`core/registry.js`](https://github.com/asasin235/HYDRA/blob/main/core/registry.js) — the single source of truth for names, models, namespaces, prompt files, and budget tiers.

## Agent Table

| # | Agent | File | Model | Tier | Purpose | Schedule |
|---|-------|------|-------|------|---------|----------|
| **00** | `architect` | `agents/00-architect.js` | Gemini 2.5 Flash | 1 | Chief of Staff: morning/evening briefs, agent watchdog, goal tracking | 6AM / 10PM daily, watchdog every 30m |
| **01** | `edmobot` | `agents/01-edmobot.js` | Claude Sonnet 4.6 | 1 | Work productivity: Jira→GitHub pipeline, auto PR, code fixes, work briefs | 9AM daily, Friday 5PM weekly |
| **02** | `brandbot` | `agents/02-brandbot.js` | Mistral Small 3.2 | 3 | Personal brand: GitHub activity → LinkedIn drafts, lead qualification | Monday 10AM |
| **03** | `sahibabot` | `agents/03-sahibabot.js` | Mistral Small 3.2 | 2 | Relationship health: nudges, promise tracking, date suggestions | 4PM daily, Monday events, 8PM promises |
| **04** | `socialbot` | `agents/04-socialbot.js` | Claude Haiku 4.5 | 2 | Social proxy: drafts WhatsApp/iMessage/Discord replies via OpenClaw | Every 2min scan, 9PM summary |
| **05** | `jarvis` | `agents/05-jarvis.js` | Gemini 2.5 Flash | 2 | Home automation via Home Assistant: AC, lights, geyser, sleep mode | Every 30m check |
| **06** | `cfobot` | `agents/06-cfobot.js` | Gemini 2.5 Pro | 1 | Personal CFO: SMS spending analysis, debt payoff, wedding fund | 11PM nightly, 1st of month |
| **07** | `biobot` | `agents/07-biobot.js` | Mistral Small 3.2 | 2 | Health tracker: Apple Health sync, HRV readiness, quit tracker | 6AM / 10PM briefs, 3PM walk nudge |
| **08** | `watchtower` | `agents/08-watchtower.js` | — (no LLM) | — | Health monitor & auto-healer: PM2 health checks, auto-restart | Every 15min sweep |
| **09** | `wolf` | `agents/09-wolf.js` | Gemini 2.5 Pro | 3 | Paper trading: Nifty F&O analysis via Perplexity, ₹1L virtual capital | Weekdays 9:30AM & 3:30PM, Sunday review |
| **10** | `mercenary` | `agents/10-mercenary.js` | Claude Sonnet 4.6 | 3 | Freelance pipeline: lead evaluation, proposal generation, invoicing | 8PM daily lead scan |
| **11** | `auditor` | `agents/11-auditor.js` | Mistral Small 3.2 | 3 | Weekly reflection: scores all agents, proposes prompt changes | Sunday 10PM |
| **12** | `careerbot` | `agents/12-careerbot.js` | Claude Sonnet 4.6 | 3 | Career strategy: GitHub profile analysis, skill gap scoring | Monday 8AM weekly |
| **99** | `slack-gateway` | `agents/99-slack-gateway.js` | — | — | Slack Bolt app: message routing, action handlers, `/hydra-status` | Always-on (Socket Mode) |

## Budget Tiers

| Tier | Agents | Budget Pause Threshold |
|------|--------|----------------------|
| **Tier 1** | architect, edmobot, cfobot | Runs to 100% of budget |
| **Tier 2** | sahibabot, biobot, jarvis, socialbot | Paused at 80% utilisation |
| **Tier 3** | brandbot, wolf, auditor, mercenary, careerbot | Paused at 60% utilisation |

## Creating a New Agent

1. **Add config** to `core/registry.js` AGENTS object:
   ```js
   '13-newbot': {
     name: '13-newbot',
     namespace: '13_NEWBOT',
     model: 'google/gemini-2.5-flash',
     tier: 3,
     promptFile: 'prompts/13-newbot.txt',
     temperature: 0.7,
     contextQuery: 'relevant search terms for LanceDB context',
     slackChannel: '#13-newbot',
   }
   ```

2. **Create agent file** `agents/13-newbot.js`:
   ```js
   import { Agent } from '../core/agent.js';
   import { validateEnv } from '../core/validate-env.js';
   import cron from 'node-cron';

   validateEnv('13-newbot');

   const tools = [
     {
       name: 'tool_name',
       description: 'What this tool does',
       parameters: {
         type: 'object',
         properties: { param: { type: 'string', description: '...' } },
         required: ['param']
       },
       execute: async ({ param }) => { /* return string */ }
     }
   ];

   const agent = new Agent({
     name: '13-newbot',
     tools,
     namespace: '13_NEWBOT'
   });

   // Schedule
   cron.schedule('0 8 * * 1', () => agent.run('Run weekly task'));
   ```

3. **Create system prompt** `prompts/13-newbot.txt`

4. **Register in PM2** — add `app('13-newbot')` to `ecosystem.config.cjs`

5. **Add env vars** to `core/validate-env.js` and `sample.env`

## Non-LLM Agents

`08-watchtower` is a pure monitoring agent — no `Agent` base class, no LLM calls, zero token cost. It uses `createLogger`, `readBrain/writeBrain`, and the PM2 CLI directly. Use this pattern for infrastructure-only agents.
