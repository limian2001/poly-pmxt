/**
 * Structured logger for pmxt TypeScript SDK.
 *
 * Thin abstraction over console that:
 * - Attaches a `[pmxt]` prefix for easy filtering
 * - Supports log levels (debug, info, warn, error)
 * - Respects a configurable level threshold via PMXT_LOG_LEVEL
 * - Can be swapped for a real transport later
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

function getDefaultLevel(): LogLevel {
    if (typeof process !== 'undefined' && process.env?.PMXT_LOG_LEVEL) {
        return process.env.PMXT_LOG_LEVEL as LogLevel;
    }
    return 'info';
}

let currentLevel: LogLevel = getDefaultLevel();

function shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

export const logger = {
    debug(message: string, context?: Record<string, unknown>): void {
        if (!shouldLog('debug')) return;
        if (context) {
            console.debug(`[pmxt] ${message}`, context);
        } else {
            console.debug(`[pmxt] ${message}`);
        }
    },

    info(message: string, context?: Record<string, unknown>): void {
        if (!shouldLog('info')) return;
        if (context) {
            console.info(`[pmxt] ${message}`, context);
        } else {
            console.info(`[pmxt] ${message}`);
        }
    },

    warn(message: string, context?: Record<string, unknown>): void {
        if (!shouldLog('warn')) return;
        if (context) {
            console.warn(`[pmxt] ${message}`, context);
        } else {
            console.warn(`[pmxt] ${message}`);
        }
    },

    error(message: string, context?: Record<string, unknown>): void {
        if (!shouldLog('error')) return;
        if (context) {
            console.error(`[pmxt] ${message}`, context);
        } else {
            console.error(`[pmxt] ${message}`);
        }
    },

    setLevel(level: LogLevel): void {
        currentLevel = level;
    },

    getLevel(): LogLevel {
        return currentLevel;
    },
};
