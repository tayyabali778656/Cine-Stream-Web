'use strict';

/**
 * middleware/security.js — Security headers, CORS, and rate limiting
 *
 * Applies production-grade security headers to every HTTP response.
 * Implements CORS enforcement and a simple in-memory rate limiter.
 */

const config = require('../config');
const logger = require('../utils/logger');

// ── Content Security Policy ───────────────────────────────────────────────────
const STREAMING_SOURCES = [
  'https://toonstream.vip',
  'https://gemma416okl.com',
  'https://9xmovielive.com',
].join(' ');

const CSP = [
  "default-src 'self'",
  `script-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://cdn.jsdelivr.net 'unsafe-inline'`,
  `style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com 'unsafe-inline'`,
  `font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:`,
  `img-src 'self' https: http: data: blob:`,
  `frame-src 'self' https: http:`,
  `connect-src 'self' https: http: https://vitals.vercel-insights.com`,
  `media-src 'self' blob: https: http:`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// ── Security headers applied to every response ────────────────────────────────
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-DNS-Prefetch-Control': 'off',
};

// Add HSTS only in production (breaks localhost dev otherwise)
if (config.isProduction) {
  SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
}

/**
 * Apply security headers to a ServerResponse.
 */
function applySecurityHeaders(res) {
  for (const [key, val] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, val);
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────
/**
 * Returns true if the request origin is allowed.
 * Always allows requests with no Origin header (same-origin / curl / server-to-server).
 */
function isOriginAllowed(origin) {
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

/**
 * Apply CORS headers. Returns false and sends 403 if origin is blocked.
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin request

  if (!isOriginAllowed(origin)) {
    logger.warn('cors_blocked', { origin, path: req.url });
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  return true;
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
// 3-tier design:
//   LOGIN tier   : 10 req / 15 min per IP  → brute-force protection on /auth/login
//   GENERAL tier : 2000 req / 15 min per IP → normal API browsing (hardcoded, NOT from env)
//   EXEMPT        : background batch endpoints bypass all limiters entirely
//
// Exempt endpoints (never counted against any limiter):
//   POST /api/v1/check-catalog   – fires in parallel for every visible card
//   POST /api/v1/missing-catalog – same batch reporter

const EXEMPT_PATHS = new Set([
  '/api/v1/check-catalog',
  '/api/v1/missing-catalog',
]);

const loginStore   = new Map(); // ip → { count, resetAt }
const generalStore = new Map(); // ip → { count, resetAt }

// Hardcoded at 2000 — deliberately NOT read from RATE_LIMIT_MAX_REQUESTS env
// (that env var stays at 100 for backwards-compat with old configs).
const LOGIN_MAX   = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10);
const LOGIN_WIN   = 15 * 60 * 1000; // 15 minutes
const GENERAL_MAX = 2000;
const GENERAL_WIN = 15 * 60 * 1000; // 15 minutes

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginStore)   { if (now > rec.resetAt) loginStore.delete(ip); }
  for (const [ip, rec] of generalStore) { if (now > rec.resetAt) generalStore.delete(ip); }
}, 5 * 60 * 1000).unref();

function _checkLimit(store, ip, max, windowMs, res, pathname) {
  const now = Date.now();
  const rec = store.get(ip);
  if (!rec || now > rec.resetAt) {
    store.set(ip, { count: 1, resetAt: now + windowMs });
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - 1);
    return true;
  }
  rec.count++;
  const remaining = Math.max(0, max - rec.count);
  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rec.resetAt / 1000));
  if (rec.count > max) {
    logger.warn('rate_limit_exceeded', { ip, path: pathname });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil(windowMs / 1000) });
    res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
    return false;
  }
  return true;
}

/**
 * Apply tiered rate limiting.
 * @param {object} req - Incoming request
 * @param {object} res - Server response
 * @param {string} pathname - URL pathname (no query string)
 * @returns {boolean} false if request was blocked (429 already sent), true otherwise
 */
function applyRateLimit(req, res, pathname) {
  // Exempt high-frequency background endpoints entirely
  if (EXEMPT_PATHS.has(pathname)) return true;

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
          || req.socket?.remoteAddress
          || 'unknown';

  // Strict limiter for login only
  if (pathname === '/api/v1/auth/login') {
    return _checkLimit(loginStore, ip, LOGIN_MAX, LOGIN_WIN, res, pathname);
  }

  // Generous limiter for all other API/proxy paths
  return _checkLimit(generalStore, ip, GENERAL_MAX, GENERAL_WIN, res, pathname);
}

module.exports = { applySecurityHeaders, applyCors, applyRateLimit };
