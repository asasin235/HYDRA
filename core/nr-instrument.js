/**
 * core/nr-instrument.js — New Relic custom instrumentation helpers for HYDRA.
 *
 * Safe wrappers around New Relic API calls. If New Relic is not loaded
 * or not active, all methods are no-ops. Mirrors the GlitchTip/Sentry
 * pattern in core/agent.js.
 */

let newrelic = null;

try {
  const mod = await import('newrelic');
  newrelic = mod.default || mod;
} catch {
  // New Relic not loaded — all methods below become no-ops
}

/**
 * Wrap an async function as a New Relic background transaction.
 * @param {string} name - Transaction name, e.g. 'HYDRA/00-architect/run'
 * @param {string} group - Transaction group, e.g. 'Agent'
 * @param {Function} fn - Async function to execute inside the transaction
 * @returns {Promise<any>} Result of fn
 */
export async function withTransaction(name, group, fn) {
  if (!newrelic) return fn();
  return new Promise((resolve, reject) => {
    newrelic.startBackgroundTransaction(name, group, async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        newrelic.noticeError(err);
        reject(err);
      }
    });
  });
}

/**
 * Record a custom event in New Relic Insights (queryable via NRQL).
 * @param {string} eventType - e.g. 'AgentRun', 'LLMCall', 'BudgetCheck'
 * @param {object} attributes - Key-value pairs
 */
export function recordEvent(eventType, attributes) {
  if (!newrelic) return;
  newrelic.recordCustomEvent(eventType, attributes);
}

/**
 * Record a custom metric value.
 * @param {string} name - Metric name, e.g. 'Custom/Agent/TokensUsed'
 * @param {number} value - Metric value
 */
export function recordMetric(name, value) {
  if (!newrelic) return;
  newrelic.recordMetric(name, value);
}

/**
 * Add custom attributes to the current transaction.
 * @param {object} attrs - Key-value pairs
 */
export function addAttributes(attrs) {
  if (!newrelic) return;
  newrelic.addCustomAttributes(attrs);
}

/**
 * Report an error to New Relic error tracking.
 * @param {Error} err
 * @param {object} [attrs] - Custom attributes
 */
export function noticeError(err, attrs) {
  if (!newrelic) return;
  newrelic.noticeError(err, attrs);
}

/**
 * Generate distributed trace headers for the current transaction.
 * Used by the publisher side of cross-process communication (e.g., Redis bus)
 * to propagate W3C traceparent/tracestate + NR proprietary header.
 * @returns {object} Headers object (empty if NR not loaded)
 */
export function insertTraceHeaders() {
  if (!newrelic) return {};
  const headers = {};
  newrelic.insertDistributedTraceHeaders(headers);
  return headers;
}

/**
 * Accept distributed trace headers on the receiving side of cross-process
 * communication. Links the current transaction to the upstream trace.
 * @param {object} headers - Headers object from insertTraceHeaders()
 * @param {'HTTP'|'HTTPS'|'Kafka'|'JMS'|'IronMQ'|'AMQP'|'Queue'|'Other'} [transport='Other']
 */
export function acceptTraceHeaders(headers, transport = 'Other') {
  if (!newrelic || !headers || Object.keys(headers).length === 0) return;
  newrelic.acceptDistributedTraceHeaders(transport, headers);
}

export { newrelic };
