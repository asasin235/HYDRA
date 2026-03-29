/**
 * Historical Interaction Priors — uses past classified interactions
 * to boost heuristic resolver confidence for repeated patterns.
 *
 * - Repeated patterns raise confidence
 * - Mixed stays mixed (no forced convergence)
 * - Unknown participants get no prior boost
 *
 * @module core/interaction-priors
 */
import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('interaction-priors');

/**
 * Minimum interactions needed before priors take effect.
 */
const MIN_HISTORY_THRESHOLD = 3;

/**
 * Maximum confidence boost from priors.
 */
const MAX_PRIOR_BOOST = 0.15;

/**
 * Look up historical classifications for a participant pair.
 * @param {string} personId - canonical person ID
 * @returns {object} prior summary { relationship, domain, count, confidence_boost }
 */
export function getParticipantPriors(personId) {
  if (!personId) return null;

  const db = getDb();

  // Find all interactions involving this person
  const interactions = db.prepare(`
    SELECT
      i.relationship_guess AS relationship_type,
      i.domain_guess AS domain,
      i.sensitivity,
      i.language_primary AS language
    FROM interactions i
    JOIN interaction_participants ip ON ip.interaction_id = i.id
    WHERE ip.person_id = ?
      AND COALESCE(i.sensitivity, 'medium') != 'restricted'
    ORDER BY COALESCE(i.started_at, i.created_at) DESC
    LIMIT 50
  `).all(personId);

  if (interactions.length < MIN_HISTORY_THRESHOLD) {
    log.debug({ personId, count: interactions.length }, 'Insufficient history for priors');
    return null;
  }

  // Count relationship types
  const relationshipCounts = {};
  const domainCounts = {};
  for (const i of interactions) {
    relationshipCounts[i.relationship_type] = (relationshipCounts[i.relationship_type] || 0) + 1;
    domainCounts[i.domain] = (domainCounts[i.domain] || 0) + 1;
  }

  const dominantRelationship = getDominant(relationshipCounts, interactions.length);
  const dominantDomain = getDominant(domainCounts, interactions.length);

  // Calculate confidence boost based on consistency
  const relationshipConsistency = dominantRelationship
    ? relationshipCounts[dominantRelationship] / interactions.length
    : 0;
  const confidenceBoost = Math.min(
    relationshipConsistency * 0.2,
    MAX_PRIOR_BOOST
  );

  const result = {
    personId,
    historyCount: interactions.length,
    relationship: dominantRelationship,
    domain: dominantDomain,
    relationshipCounts,
    domainCounts,
    confidenceBoost,
  };

  log.info(result, 'Participant priors resolved');
  return result;
}

/**
 * Get dominant value from counts, respecting 'mixed' rules.
 * If no single type exceeds 60% threshold, returns 'mixed'.
 * If the dominant type IS 'mixed', stay mixed.
 */
function getDominant(counts, total) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'unknown';

  const [topType, topCount] = entries[0];

  // 'mixed' stays mixed — no forced convergence
  if (topType === 'mixed' && topCount / total > 0.4) return 'mixed';

  // Threshold: >60% of history must agree for a confident prior
  if (topCount / total > 0.6) return topType;

  // No clear dominant pattern
  return 'mixed';
}

/**
 * Apply priors to a heuristic classification result.
 * Boosts confidence if priors align with the heuristic guess.
 * Does NOT override the heuristic — only adjusts confidence.
 *
 * @param {object} heuristicResult - { relationship_type, domain, confidence }
 * @param {string} personId
 * @returns {object} adjusted result with prior metadata
 */
export function applyPriors(heuristicResult, personId) {
  const priors = getParticipantPriors(personId);
  if (!priors) {
    return { ...heuristicResult, priorApplied: false };
  }

  const result = { ...heuristicResult, priorApplied: true, priorData: priors };

  // Boost confidence if prior aligns
  if (priors.relationship === heuristicResult.relationship_type) {
    result.confidence = Math.min(1.0, heuristicResult.confidence + priors.confidenceBoost);
    result.priorBoost = priors.confidenceBoost;
    log.info(
      { personId, boost: priors.confidenceBoost, newConfidence: result.confidence },
      'Prior confidence boost applied'
    );
  }

  // If prior says mixed but heuristic is specific, lower confidence slightly
  if (priors.relationship === 'mixed' && heuristicResult.relationship_type !== 'mixed') {
    result.confidence = Math.max(0.1, heuristicResult.confidence - 0.05);
    result.priorPenalty = 0.05;
    log.info({ personId }, 'Mixed prior penalized specific heuristic');
  }

  return result;
}

/**
 * Get priors for multiple participants at once.
 */
export function getBatchPriors(personIds) {
  return personIds
    .filter(Boolean)
    .map(id => ({ personId: id, priors: getParticipantPriors(id) }))
    .filter(p => p.priors !== null);
}
