/**
 * core/validate-env.js — Per-agent environment variable validation.
 *
 * Usage:
 *   validateEnv('05-jarvis')  → checks OPENROUTER_API_KEY + BRAIN_PATH + HA vars
 *   validateEnv()             → checks core vars only
 */

/** Variables required by every agent */
const CORE_REQUIRED = [
  'OPENROUTER_API_KEY',
  'BRAIN_PATH',
];

/** Variables required by the Slack gateway (and any agent that posts to Slack) */
const SLACK_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
];

/** Per-agent additional required variables */
const AGENT_REQUIRED = {
  '99-slack-gateway': SLACK_VARS,
  '00-architect':     SLACK_VARS,
  '01-edmobot':       SLACK_VARS,
  '02-brandbot':      [...SLACK_VARS, 'GITHUB_USERNAME', 'GITHUB_TOKEN'],
  '03-sahibabot':     SLACK_VARS,
  '04-socialbot':     SLACK_VARS,
  '05-jarvis':        [...SLACK_VARS, 'HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN'],
  '06-cfobot':        SLACK_VARS,
  '07-biobot':        SLACK_VARS,
  '09-wolf':          [...SLACK_VARS, 'PERPLEXITY_API_KEY'],
  '10-mercenary':     SLACK_VARS,
  '11-auditor':       [...SLACK_VARS, 'INTERNAL_API_KEY'],
};

/**
 * Validate required environment variables for an agent.
 * Throws with a clear message listing all missing vars if any are absent.
 *
 * @param {string|null} [agentName=null] - Agent name (e.g. '05-jarvis'). Null = core only.
 */
export function validateEnv(agentName = null) {
  const required = [
    ...CORE_REQUIRED,
    ...(agentName && AGENT_REQUIRED[agentName] ? AGENT_REQUIRED[agentName] : []),
  ];

  // Deduplicate
  const unique = [...new Set(required)];
  const missing = unique.filter(k => !process.env[k] || String(process.env[k]).trim() === '');

  for (const k of missing) {
    console.error(`❌ MISSING ENV: ${k}${agentName ? ` (required by ${agentName})` : ''}`);
  }

  if (missing.length) {
    throw new Error(
      `HYDRA startup failed: ${missing.length} env var(s) missing for ${agentName || 'core'}. Check .env file.`
    );
  }
}
