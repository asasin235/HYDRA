/**
 * Domain-Aware Search Wrappers — high-level search functions
 * scoped by domain, person, or agent role.
 *
 * - searchWorkContext()    — work domain only
 * - searchPersonalContext() — personal/family domain
 * - searchByPerson()       — all interactions involving a person
 * - searchForArchitect()   — broad summaries, no raw transcripts
 *
 * @module core/search-wrappers
 */
import { queryInteractions, queryByPerson } from './retrieval-filters.js';
import { filterByPolicy, applyTranscriptSuppression } from './memory-policy.js';
import { createLogger } from './logger.js';

const log = createLogger('search-wrappers');

/**
 * Search work-domain interactions.
 * Excludes restricted by default.
 * @param {object} [options] - limit, offset, relationship, sensitivity
 * @returns {Array}
 */
export function searchWorkContext(options = {}) {
  const filters = {
    domain: 'work',
    ...options,
  };
  log.info({ filters }, 'Searching work context');
  return queryInteractions(filters, { limit: options.limit || 25, offset: options.offset || 0 });
}

/**
 * Search personal-domain interactions (personal + family).
 * @param {object} [options]
 * @returns {Array}
 */
export function searchPersonalContext(options = {}) {
  const filters = {
    ...options,
  };
  // personal context includes both 'personal' and 'family' domains
  // query each and merge
  const personal = queryInteractions(
    { ...filters, domain: 'personal' },
    { limit: options.limit || 25, offset: options.offset || 0 }
  );
  const family = queryInteractions(
    { ...filters, domain: 'family' },
    { limit: options.limit || 25, offset: options.offset || 0 }
  );

  const merged = [...personal, ...family]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, options.limit || 25);

  log.info({ count: merged.length }, 'Personal context search results');
  return merged;
}

/**
 * Search all interactions involving a specific person.
 * @param {string} personId
 * @param {object} [options]
 * @returns {Array}
 */
export function searchByPerson(personId, options = {}) {
  if (!personId) throw new Error('personId is required');
  log.info({ personId }, 'Searching by person');
  return queryByPerson(personId, options, { limit: options.limit || 25, offset: options.offset || 0 });
}

/**
 * Search for the architect agent.
 * Returns broad summaries only — no raw transcripts, no restricted content.
 * @param {object} [options]
 * @returns {Array}
 */
export function searchForArchitect(options = {}) {
  const results = queryInteractions(
    { ...options, includeRestricted: false },
    { limit: options.limit || 25, offset: options.offset || 0 }
  );
  return filterByPolicy(results, 'architect');
}

/**
 * Generic scoped search with agent policy enforcement.
 * @param {string} agentName
 * @param {object} filters
 * @param {object} [options]
 * @returns {Array}
 */
export function scopedSearch(agentName, filters = {}, options = {}) {
  const results = queryInteractions(filters, {
    limit: options.limit || 25,
    offset: options.offset || 0,
  });
  return filterByPolicy(results, agentName);
}

/**
 * Multi-domain search — query across multiple domains at once.
 * @param {string[]} domains
 * @param {object} [options]
 * @returns {Array}
 */
export function searchMultiDomain(domains, options = {}) {
  const allResults = [];
  for (const domain of domains) {
    const results = queryInteractions(
      { ...options, domain },
      { limit: options.limit || 10, offset: 0 }
    );
    allResults.push(...results);
  }
  return allResults
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, options.limit || 25);
}
