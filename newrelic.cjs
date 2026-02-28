'use strict';

/**
 * New Relic agent configuration for HYDRA.
 *
 * App name is set per-process via NEW_RELIC_APP_NAME env var in ecosystem.config.cjs.
 * License key is set via NEW_RELIC_LICENSE_KEY in the PM2 env block.
 *
 * Docs: https://docs.newrelic.com/docs/apm/agents/nodejs-agent/installation-configuration/nodejs-agent-configuration/
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'HYDRA'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY || '',

  // EU region account — must point to EU collector
  host: 'collector.eu01.nr-data.net',

  distributed_tracing: {
    enabled: true,
  },

  span_events: {
    enabled: true,
    max_samples_stored: 2000,
  },

  // Disable legacy Cross-Application Tracing — using W3C distributed tracing instead
  cross_application_tracer: {
    enabled: false,
  },

  transaction_tracer: {
    enabled: true,
    record_sql: 'obfuscated',
    explain_threshold: 200,
  },

  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },

  custom_insights_events: {
    enabled: true,
    max_samples_stored: 3000,
  },

  logging: {
    enabled: true,
    level: process.env.NEW_RELIC_LOG_LEVEL || 'info',
    filepath: './logs/newrelic_agent.log',
  },

  // Disable timer instrumentation — HYDRA agents use setInterval for heartbeats
  // and cron scheduling, which creates excessive trace noise
  instrumentation: {
    timers: { enabled: false },
  },

  allow_all_headers: true,

  attributes: {
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.proxyAuthorization',
      'request.headers.setCookie*',
      'request.headers.x*',
      'response.headers.cookie',
      'response.headers.authorization',
      'response.headers.proxyAuthorization',
      'response.headers.setCookie*',
      'response.headers.x*',
    ],
  },

  // Auto-forward Winston logs to New Relic Logs
  application_logging: {
    enabled: true,
    forwarding: {
      enabled: true,
      max_samples_stored: 10000,
    },
    local_decorating: { enabled: false },
  },

  labels: {
    project: 'HYDRA',
    environment: process.env.NODE_ENV || 'production',
  },
};
