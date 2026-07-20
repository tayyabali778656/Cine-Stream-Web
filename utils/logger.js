'use strict';

/**
 * utils/logger.js — Structured JSON logger
 *
 * Outputs JSON lines to stdout. Each line is a structured log entry
 * that can be ingested by any log aggregation system (Datadog, Logtail, etc.)
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started', { port: 3000 });
 *   logger.request(req, res, durationMs);
 *   logger.error('DB failed', err);
 */

const config = require('../config');

// In-memory performance metrics (reset on restart)
const metrics = {
  requestsTotal: 0,
  errorsTotal: 0,
  slowRequests: 0,       // requests > 500ms
  dbQueriesTotal: 0,
  dbTotalMs: 0,
  streamErrors: 0,
  cacheHits: 0,
  cacheMisses: 0,
  startedAt: Date.now(),
};

/**
 * Core log writer — writes a JSON line to stdout
 */
function write(level, message, data = {}) {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...data,
  };
  // In production, write pure JSON. In development, pretty-print for readability
  if (config.isProduction) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const color = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', debug: '\x1b[90m' };
    const reset = '\x1b[0m';
    const c = color[level] || reset;
    const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    console.log(`${c}[${level.toUpperCase()}]${reset} ${entry.time} ${message}${extra}`);
  }
}

const logger = {
  info:  (msg, data) => write('info', msg, data),
  warn:  (msg, data) => write('warn', msg, data),
  error: (msg, err) => write('error', msg, err instanceof Error
    ? { errorMessage: err.message, stack: config.isProduction ? undefined : err.stack }
    : err),
  debug: (msg, data) => { if (!config.isProduction) write('debug', msg, data); },

  /**
   * Log an HTTP request/response cycle
   */
  request(req, statusCode, durationMs) {
    metrics.requestsTotal++;
    if (durationMs > 500) metrics.slowRequests++;
    if (statusCode >= 500) metrics.errorsTotal++;

    write('info', 'http', {
      method: req.method,
      path: (req.url || '').split('?')[0],
      status: statusCode,
      duration_ms: durationMs,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      ua: (req.headers['user-agent'] || '').substring(0, 80),
    });
  },

  /**
   * Log a database operation
   */
  db(operation, collection, durationMs, error) {
    metrics.dbQueriesTotal++;
    metrics.dbTotalMs += durationMs;
    if (error) {
      write('error', 'db_error', { operation, collection, duration_ms: durationMs, error: error.message });
    } else if (durationMs > 200) {
      write('warn', 'db_slow', { operation, collection, duration_ms: durationMs });
    }
  },

  /**
   * Log a streaming event (start, error, switch, end)
   */
  stream(event, data) {
    if (event === 'error') metrics.streamErrors++;
    write('info', `stream_${event}`, data);
  },

  /**
   * Record a cache hit or miss
   */
  cache(hit) {
    if (hit) metrics.cacheHits++;
    else metrics.cacheMisses++;
  },

  /**
   * Log a failed login attempt
   */
  authFail(ip, email) {
    write('warn', 'auth_fail', { ip, email, time: new Date().toISOString() });
  },

  /**
   * Log proxy request
   */
  proxy(targetUrl, statusCode, durationMs) {
    write('info', 'proxy', { target: targetUrl, status: statusCode, duration_ms: durationMs });
  },

  /**
   * Get current performance snapshot (for /health endpoint)
   */
  getMetrics() {
    const uptimeMs = Date.now() - metrics.startedAt;
    const mem = process.memoryUsage();
    const cacheTotal = metrics.cacheHits + metrics.cacheMisses;
    return {
      uptime_s: Math.floor(uptimeMs / 1000),
      requests_total: metrics.requestsTotal,
      errors_total: metrics.errorsTotal,
      slow_requests: metrics.slowRequests,
      stream_errors: metrics.streamErrors,
      db_queries: metrics.dbQueriesTotal,
      db_avg_ms: metrics.dbQueriesTotal > 0 ? Math.round(metrics.dbTotalMs / metrics.dbQueriesTotal) : 0,
      cache_hit_ratio: cacheTotal > 0 ? (metrics.cacheHits / cacheTotal).toFixed(2) : 'N/A',
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
    };
  },
};

module.exports = logger;
