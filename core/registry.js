/**
 * core/registry.js — Single source of truth for all HYDRA agent configuration.
 *
 * Previously this metadata was duplicated across:
 *   - agents/00-architect.js (AGENTS array + AGENT_NAMESPACES map)
 *   - agents/11-auditor.js   (AGENT_REGISTRY object)
 *   - core/bottleneck.js     (TIER1/TIER2/TIER3 arrays)
 *
 * This file is now the authoritative source. All other files should import from here.
 */

/**
 * @typedef {Object} AgentConfig
 * @property {string} namespace     - Brain storage namespace (e.g. '01_EDMO')
 * @property {string} model         - OpenRouter model string
 * @property {string} promptFile    - Filename under prompts/ directory
 * @property {1|2|3}  tier          - Budget tier (1=critical, 2=important, 3=optional)
 * @property {string} [slackChannel] - Agent's default Slack channel
 * @property {number} [temperature]  - LLM temperature (0.0–1.0), defaults to 0.4
 * @property {number} [maxContextTokens] - Max tokens for context window guard, null for no-model agents
 * @property {number} [maxHistoryTurns] - Max conversation history turns to inject, defaults to 10
 */

/** @type {Object.<string, AgentConfig>} */
export const AGENTS = {
  '00-architect': { namespace: '00_ARCHITECT', model: 'google/gemini-2.5-flash', promptFile: '00-architect.txt', tier: 1, temperature: 0.4, maxContextTokens: 200000, contextQuery: 'daily progress goals alignment productivity health finances relationship', slackChannel: '#00-architect' },
  '01-edmobot': { namespace: '01_EDMO', model: 'anthropic/claude-sonnet-4.6', promptFile: '01-edmobot.txt', tier: 1, temperature: 0.15, maxContextTokens: 150000, contextQuery: 'coding backend Node.js Vapi work tasks Jira pull requests engineering', slackChannel: '#01-edmobot' },
  '02-brandbot': { namespace: '02_BRAND', model: 'mistralai/mistral-small-3.2-24b-instruct', promptFile: '02-brandbot.txt', tier: 3, temperature: 0.75, maxContextTokens: 24000, maxHistoryTurns: 4, contextQuery: 'social media content LinkedIn Twitter freelance leads marketing brand', slackChannel: '#02-brandbot' },
  '03-sahibabot': { namespace: '03_SAHIBA', model: 'mistralai/mistral-small-3.2-24b-instruct', promptFile: '03-sahibabot.txt', tier: 2, temperature: 0.7, maxContextTokens: 24000, maxHistoryTurns: 4, contextQuery: 'Sabiha relationship personal messages calls wedding plans gifts', slackChannel: '#03-sahibabot' },
  '04-socialbot': { namespace: '04_SOCIAL', model: 'anthropic/claude-haiku-4-5', promptFile: '04-socialbot.txt', tier: 2, temperature: 0.5, maxContextTokens: 150000, contextQuery: 'WhatsApp iMessage Discord messages conversations social replies', slackChannel: '#04-socialbot' },
  '05-jarvis': { namespace: '05_JARVIS', model: 'google/gemini-2.5-flash', promptFile: '05-jarvis.txt', tier: 2, temperature: 0.3, maxContextTokens: 200000, contextQuery: 'home automation lights temperature air quality smart home IoT', slackChannel: '#05-jarvis' },
  '06-cfobot': { namespace: '06_CFO', model: 'google/gemini-2.5-pro', promptFile: '06-cfobot.txt', tier: 1, temperature: 0.15, maxContextTokens: 200000, contextQuery: 'finances budget expenses debt payments bank salary invoices transactions money', slackChannel: '#06-cfobot' },
  '07-biobot': { namespace: '07_BIO', model: 'mistralai/mistral-small-3.2-24b-instruct', promptFile: '07-biobot.txt', tier: 2, temperature: 0.4, maxContextTokens: 24000, maxHistoryTurns: 4, contextQuery: 'health fitness exercise sleep diet smoking steps heart rate wellness', slackChannel: '#07-biobot' },
  '08-watchtower': { namespace: '08_WATCHTOWER', model: null, promptFile: null, tier: 1, temperature: null, maxContextTokens: null, contextQuery: null, slackChannel: '#hydra-status' },
  '09-wolf': { namespace: '09_WOLF', model: 'google/gemini-2.5-pro', promptFile: '09-wolf.txt', tier: 3, temperature: 0.3, maxContextTokens: 200000, contextQuery: 'trading stocks options F&O market portfolio investments Nifty risk', slackChannel: '#09-wolf' },
  '10-mercenary': { namespace: '10_MERCENARY', model: 'anthropic/claude-sonnet-4.6', promptFile: '10-mercenary.txt', tier: 3, temperature: 0.5, maxContextTokens: 150000, contextQuery: 'freelance clients projects code deployment contracts deadlines', slackChannel: '#10-mercenary' },
  '11-auditor': { namespace: '11_AUDITOR', model: 'mistralai/mistral-small-3.2-24b-instruct', promptFile: '11-auditor.txt', tier: 3, temperature: 0.3, maxContextTokens: 24000, maxHistoryTurns: 4, contextQuery: 'agent performance metrics errors logs uptime budget utilisation', slackChannel: '#11-auditor' },
  '12-careerbot': { namespace: '12_CAREER', model: 'anthropic/claude-sonnet-4.6', promptFile: '12-careerbot.txt', tier: 3, temperature: 0.4, maxContextTokens: 150000, contextQuery: 'career jobs skills resume portfolio GitHub contributions LinkedIn experience', slackChannel: '#12-careerbot' },
  '99-slack-gateway': { namespace: '99_GATEWAY', model: null, promptFile: null, tier: 1, temperature: null, maxContextTokens: null, slackChannel: null },
};

/** All agent names in order */
export const AGENT_NAMES = Object.keys(AGENTS);

/** Agent names that have their own processes (no reserved/gateway) */
export const ACTIVE_AGENT_NAMES = AGENT_NAMES.filter(n => !['99-slack-gateway'].includes(n));

/** Tier 1: critical — run up to 100% budget */
export const TIER1 = AGENT_NAMES.filter(n => AGENTS[n].tier === 1);

/** Tier 2: important — paused at 80% budget utilisation */
export const TIER2 = AGENT_NAMES.filter(n => AGENTS[n].tier === 2);

/** Tier 3: optional — paused at 60% budget utilisation */
export const TIER3 = AGENT_NAMES.filter(n => AGENTS[n].tier === 3);

/**
 * Map of agent name → namespace (for watchdog / heartbeat lookups)
 * @type {Object.<string, string>}
 */
export const AGENT_NAMESPACES = Object.fromEntries(
  AGENT_NAMES.map(n => [n, AGENTS[n].namespace])
);
