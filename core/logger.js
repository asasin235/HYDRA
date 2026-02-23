/**
 * core/logger.js — Winston-based structured logger for HYDRA agents.
 *
 * Usage:
 *   import { createLogger } from '../core/logger.js';
 *   const log = createLogger('05-jarvis');
 *
 *   log.info('AC turned off');
 *   log.warn('Budget at 80%', { agent: '05-jarvis', budget: 80 });
 *   log.error('HA call failed', { error: err.message });
 */
import winston from 'winston';

const { format, transports } = winston;

const IS_PM2 = !!process.env.PM2_HOME || !!process.env.NODE_APP_INSTANCE;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Create a named Winston logger for a specific agent or module.
 * @param {string} name - Agent or module name (e.g. '05-jarvis', 'slack-gateway')
 * @returns {import('winston').Logger}
 */
export function createLogger(name) {
    const label = `[${name}]`;

    // In PM2 production: output JSON for easy parsing and log aggregation
    // In dev / local: output pretty colour-coded text
    const logFormat = IS_PM2
        ? format.combine(
            format.timestamp(),
            format.errors({ stack: true }),
            format.json()
        )
        : format.combine(
            format.colorize(),
            format.timestamp({ format: 'HH:mm:ss' }),
            format.errors({ stack: true }),
            format.printf(({ level, message, timestamp, ...meta }) => {
                const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
                return `${timestamp} ${level} ${label} ${message}${metaStr}`;
            })
        );

    return winston.createLogger({
        level: LOG_LEVEL,
        format: logFormat,
        defaultMeta: { agent: name },
        transports: [
            new transports.Console(),
        ],
    });
}

/**
 * Shared root logger for non-agent modules (core, scripts).
 * @type {import('winston').Logger}
 */
export const rootLogger = createLogger('hydra');
