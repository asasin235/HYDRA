/**
 * Memory Policy — enforces restricted memory access controls.
 *
 * - Restricted items excluded from generic search
 * - Transcript suppression: summary-only for restricted content
 * - Agent access policy: per-agent visibility rules
 *
 * @module core/memory-policy
 */
import { createLogger } from './logger.js';

const log = createLogger('memory-policy');

/**
 * Sensitivity levels in ascending order.
 */
const SENSITIVITY_ORDER = ['low', 'medium', 'high', 'restricted'];

/**
 * Default agent access policy.
 * Agents see everything except restricted unless explicitly granted.
 */
const DEFAULT_AGENT_POLICY = {
  maxSensitivity: 'high', // can see low, medium, high — not restricted
  canViewRawTranscript: true,
  restrictedAccess: false,
};

/**
 * Agent-specific overrides.
 * Keys are agent names or IDs.
 */
const AGENT_POLICIES = {
  architect: {
    maxSensitivity: 'high',
    canViewRawTranscript: false, // broad summaries only
    restrictedAccess: false,
  },
  personal: {
    maxSensitivity: 'restricted',
    canViewRawTranscript: true,
    restrictedAccess: true, // personal agent can see restricted
  },
  review: {
    maxSensitivity: 'restricted',
    canViewRawTranscript: true,
    restrictedAccess: true, // review agent needs full access
  },
};

/**
 * Get the effective access policy for an agent.
 * @param {string} agentName
 * @returns {object} policy
 */
export function getAgentPolicy(agentName) {
  const policy = AGENT_POLICIES[agentName] || DEFAULT_AGENT_POLICY;
  log.debug({ agentName, policy }, 'Resolved agent policy');
  return policy;
}

/**
 * Check if an agent can access a given sensitivity level.
 * @param {string} agentName
 * @param {string} sensitivity
 * @returns {boolean}
 */
export function canAccessSensitivity(agentName, sensitivity) {
  const policy = getAgentPolicy(agentName);
  const agentMaxIndex = SENSITIVITY_ORDER.indexOf(policy.maxSensitivity);
  const itemIndex = SENSITIVITY_ORDER.indexOf(sensitivity);
  if (agentMaxIndex < 0 || itemIndex < 0) return false;
  return itemIndex <= agentMaxIndex;
}

/**
 * Check if restricted content is accessible for a given agent.
 */
export function canAccessRestricted(agentName) {
  const policy = getAgentPolicy(agentName);
  return policy.restrictedAccess === true;
}

/**
 * Apply transcript suppression for an interaction record.
 * If the agent cannot view raw transcripts, only the summary is returned.
 * If the content is restricted and agent lacks access, summary is redacted.
 *
 * @param {object} interaction - { summary, raw_transcript, sensitivity, ... }
 * @param {string} agentName
 * @returns {object} sanitized interaction
 */
export function applyTranscriptSuppression(interaction, agentName) {
  const policy = getAgentPolicy(agentName);
  const result = { ...interaction };

  // Restricted content: check access
  if (interaction.sensitivity === 'restricted' && !policy.restrictedAccess) {
    result.summary = '[RESTRICTED — access denied]';
    result.raw_transcript = null;
    result.redacted = true;
    log.info({ agentName, interactionId: interaction.id }, 'Restricted content redacted');
    return result;
  }

  // Transcript suppression: summary-only agents
  if (!policy.canViewRawTranscript) {
    result.raw_transcript = null;
    result.transcript_suppressed = true;
  }

  return result;
}

/**
 * Filter a list of interactions based on agent policy.
 * Removes restricted items the agent cannot see and applies suppression.
 *
 * @param {Array} interactions
 * @param {string} agentName
 * @returns {Array} filtered and sanitized interactions
 */
export function filterByPolicy(interactions, agentName) {
  return interactions
    .filter(i => canAccessSensitivity(agentName, i.sensitivity))
    .map(i => applyTranscriptSuppression(i, agentName));
}

/**
 * Check if a search query should exclude restricted content.
 * Generic search always excludes restricted.
 * Explicit restricted queries require agent opt-in.
 */
export function shouldExcludeRestricted(agentName, isExplicitQuery = false) {
  if (isExplicitQuery && canAccessRestricted(agentName)) {
    return false;
  }
  return true;
}

/**
 * Register a custom agent policy at runtime.
 */
export function registerAgentPolicy(agentName, policy) {
  AGENT_POLICIES[agentName] = { ...DEFAULT_AGENT_POLICY, ...policy };
  log.info({ agentName }, 'Agent policy registered');
}
