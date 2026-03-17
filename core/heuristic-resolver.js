/**
 * Heuristic Resolver — resolves relationship type and domain from transcript text.
 * Uses keyword-based heuristics with participant context boosting.
 * @module core/heuristic-resolver
 */
import { createLogger } from './logger.js';

const log = createLogger('heuristic-resolver');

const VALID_RELATIONSHIP_TYPES = ['friend', 'family', 'coworker', 'manager', 'client', 'partner', 'vendor', 'mixed', 'unknown'];
const VALID_DOMAINS = ['work', 'personal', 'family', 'finance', 'health', 'mixed', 'unknown'];

const WORK_KEYWORDS = [
  'meeting', 'project', 'deadline', 'sprint', 'deploy', 'release', 'client',
  'presentation', 'report', 'standup', 'scrum', 'jira', 'linear', 'slack',
  'revenue', 'budget', 'quarterly', 'okr', 'kpi', 'roadmap', 'stakeholder',
  'invoice', 'contract', 'deliverable', 'milestone', 'pipeline'
];

const PERSONAL_KEYWORDS = [
  'dinner', 'movie', 'weekend', 'vacation', 'birthday', 'party', 'hangout',
  'gym', 'workout', 'recipe', 'restaurant', 'travel', 'trip', 'hobby',
  'game', 'music', 'concert', 'festival', 'date', 'wedding'
];

const FAMILY_KEYWORDS = [
  'mom', 'dad', 'mother', 'father', 'sister', 'brother', 'parent',
  'family', 'cousin', 'aunt', 'uncle', 'grandma', 'grandpa', 'kid',
  'son', 'daughter', 'nephew', 'niece', 'maa', 'papa', 'bhai', 'didi'
];

const FINANCE_KEYWORDS = [
  'payment', 'salary', 'investment', 'bank', 'loan', 'emi', 'tax',
  'insurance', 'credit', 'debit', 'savings', 'expense', 'stock', 'mutual fund'
];

const HEALTH_KEYWORDS = [
  'doctor', 'hospital', 'medicine', 'appointment', 'health', 'therapy',
  'prescription', 'symptom', 'diagnosis', 'checkup', 'surgery', 'clinic'
];

const COWORKER_SIGNALS = ['colleague', 'team', 'manager', 'boss', 'coworker', 'office', 'work with'];
const FRIEND_SIGNALS = ['friend', 'buddy', 'dude', 'bro', 'yaar', 'bhai', 'hangout', 'chill'];
const FAMILY_SIGNALS = ['mom', 'dad', 'sister', 'brother', 'parent', 'family', 'maa', 'papa', 'bhai', 'didi'];
const CLIENT_SIGNALS = ['client', 'customer', 'vendor', 'contractor', 'freelancer'];
const MANAGER_SIGNALS = ['boss', 'manager', 'supervisor', 'lead', 'director', 'reporting to'];

/**
 * Resolve domain heuristically from transcript text.
 * @param {string} text
 * @returns {string} One of VALID_DOMAINS
 */
export function resolveDomain(text) {
  if (!text || typeof text !== 'string') return 'unknown';

  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  const scores = { work: 0, personal: 0, family: 0, finance: 0, health: 0 };

  for (const word of words) {
    const cleaned = word.replace(/[^a-z]/g, '');
    if (WORK_KEYWORDS.includes(cleaned)) scores.work++;
    if (PERSONAL_KEYWORDS.includes(cleaned)) scores.personal++;
    if (FAMILY_KEYWORDS.includes(cleaned)) scores.family++;
    if (FINANCE_KEYWORDS.includes(cleaned)) scores.finance++;
    if (HEALTH_KEYWORDS.includes(cleaned)) scores.health++;
  }

  // Check multi-word phrases
  for (const phrase of FINANCE_KEYWORDS.filter(k => k.includes(' '))) {
    if (lower.includes(phrase)) scores.finance += 2;
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'unknown';

  const topDomains = Object.entries(scores).filter(([, s]) => s === maxScore);
  if (topDomains.length > 1) return 'mixed';

  const result = topDomains[0][0];
  log.debug({ scores, result }, 'Domain resolved');
  return result;
}

/**
 * Resolve relationship type heuristically from transcript text and participant context.
 * @param {string} text
 * @param {object} participantContext - Optional known relationship context.
 * @returns {string} One of VALID_RELATIONSHIP_TYPES
 */
export function resolveRelationship(text, participantContext = {}) {
  if (!text || typeof text !== 'string') return 'unknown';

  const lower = text.toLowerCase();
  const scores = { coworker: 0, friend: 0, family: 0, client: 0, manager: 0 };

  for (const signal of COWORKER_SIGNALS) { if (lower.includes(signal)) scores.coworker++; }
  for (const signal of FRIEND_SIGNALS) { if (lower.includes(signal)) scores.friend++; }
  for (const signal of FAMILY_SIGNALS) { if (lower.includes(signal)) scores.family++; }
  for (const signal of CLIENT_SIGNALS) { if (lower.includes(signal)) scores.client++; }
  for (const signal of MANAGER_SIGNALS) { if (lower.includes(signal)) scores.manager++; }

  // Boost from known participant relationship
  if (participantContext.knownRelationship && VALID_RELATIONSHIP_TYPES.includes(participantContext.knownRelationship)) {
    const known = participantContext.knownRelationship;
    if (scores[known] !== undefined) {
      scores[known] += 3;
    }
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'unknown';

  const topRelationships = Object.entries(scores).filter(([, s]) => s === maxScore);
  if (topRelationships.length > 1) return 'mixed';

  const result = topRelationships[0][0];
  log.debug({ scores, result }, 'Relationship resolved');
  return result;
}

/**
 * Combined heuristic resolution.
 * @param {string} text
 * @param {object} participantContext
 * @returns  domain: string, relationship: string, confidence: number 
 */
export function resolveHeuristics(text, participantContext = {}) {
  const domain = resolveDomain(text);
  const relationship = resolveRelationship(text, participantContext);

  const lower = (text || '').toLowerCase();
  const allKeywords = [...WORK_KEYWORDS, ...PERSONAL_KEYWORDS, ...FAMILY_KEYWORDS, ...FINANCE_KEYWORDS, ...HEALTH_KEYWORDS];
  const matchCount = allKeywords.filter(k => lower.includes(k)).length;
  const wordCount = (text || '').split(/\s+/).length;
  const confidence = wordCount > 0 ? Math.min(matchCount / Math.sqrt(wordCount), 1.0) : 0;

  return {
    domain,
    relationship,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export { VALID_RELATIONSHIP_TYPES, VALID_DOMAINS };
