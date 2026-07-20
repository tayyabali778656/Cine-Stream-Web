'use strict';

/**
 * config.js — Centralized configuration & startup environment validation
 *
 * Loads environment variables and exports a single validated config object.
 * Throws at startup if any critical variable is missing so the server
 * fails fast instead of silently misbehaving in production.
 */

const fs = require('fs');
const path = require('path');

// ── Minimal .env loader (no external dependency) ─────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return; // .env is optional; use system env vars
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, ''); // strip quotes
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

// ── Validation helper ─────────────────────────────────────────────────────────
function required(key, fallback) {
  const val = process.env[key] || fallback;
  if (!val) {
    console.error(`[CONFIG] FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return val;
}

function optional(key, fallback = '') {
  return process.env[key] || fallback;
}

// ── Exported config ───────────────────────────────────────────────────────────
const config = {
  // Server
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  // MongoDB
  mongoUri: required('MONGODB_URI'),

  // Auth
  jwtSecret: required('JWT_SECRET', (() => {
    // In development, generate a random secret as last resort (logs a warning)
    const devSecret = 'dev_jwt_secret_INSECURE_do_not_use_in_production_' + Math.random().toString(36);
    if (optional('NODE_ENV', 'development') !== 'production') {
      console.warn('[CONFIG] WARNING: JWT_SECRET not set — using ephemeral secret. Sessions will not persist across restarts!');
    }
    return devSecret;
  })()),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '24h'),
  jwtRefreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  adminEmail: optional('ADMIN_EMAIL', 'tayyabdev@make.com'),
  adminPasswordHash: optional('ADMIN_PASSWORD_HASH', ''), // bcrypt hash

  // ToonStream (scraper source)
  toonstreamBaseUrl: 'https://toon-stream.site',

  // Streaming
  streamPlayerUrl: optional('STREAM_PLAYER_URL', 'https://gemma416okl.com/play/'),

  // CORS — comma-separated list of trusted origins
  allowedOrigins: optional('ALLOWED_ORIGINS', 'http://localhost:3000,https://cinestream-ten-nu.vercel.app,https://cinestream.watch')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Rate limiting
  rateLimitWindowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10), // 1 min window
  rateLimitMax: parseInt(optional('RATE_LIMIT_MAX_REQUESTS', '5000'), 10),
  loginRateLimitMax: parseInt(optional('LOGIN_RATE_LIMIT_MAX', '100'), 10),

  // Proxy strict whitelist (private IPs are always blocked in isProxyAllowed)
  proxyWhitelist: new Set([
    'toon-stream.site',
    'rubystm.com',
    'image.tmdb.org', // kept for admin panel backward-compat poster URLs
    'toonstream.vip',
    'gemma416okl.com',
    '9xmovielive.com',
    'allmovieland.one',   // allmovieland.you now redirects here
    'allmovieland.you',
  ]),

  // Allowed MongoDB collections via REST API
  allowedCollections: new Set([
    'admin-store',
    'broken-videos',
    'missing-catalog',
    'hidden-items',
    'hindi-dubbed',
    'anime',
    'episodes',
    'genres',
    'featured',
    'latest',
    'popular',
    'searchIndex',
  ]),

  // Cache TTLs (milliseconds)
  cacheTtl: {
    tmdb: 24 * 60 * 60 * 1000,      // 24 hours
    dbCollection: 5 * 60 * 1000,     // 5 minutes
    catalog: 60 * 60 * 1000,         // 1 hour
    staticEtag: 24 * 60 * 60 * 1000, // 24 hours
  },
};

module.exports = config;
