'use strict';

/**
 * services/auth.js — JWT-based authentication service
 *
 * Uses Node's built-in `crypto` module for HMAC-SHA256 JWT signing/verification
 * and `bcryptjs` (pure-JS, no native compilation) for password hashing.
 *
 * Token structure: base64url(header).base64url(payload).base64url(signature)
 * Tokens are delivered as HTTP-only, Secure, SameSite=Strict cookies.
 */

const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('../utils/logger');

// ── bcryptjs lazy-loader with graceful fallback ───────────────────────────────
let bcrypt = null;
function getBcrypt() {
  if (bcrypt) return bcrypt;
  try {
    bcrypt = require('bcryptjs');
  } catch {
    logger.warn('bcryptjs not installed — password verification disabled. Run: npm install bcryptjs');
  }
  return bcrypt;
}

// ── Minimal JWT implementation using Node crypto ──────────────────────────────
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${HEADER}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payloadB64, sig] = parts;
  const data = `${header}.${payloadB64}`;
  const expectedSig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

// ── Rate limiter for login attempts ───────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const window = config.rateLimitWindowMs || 900_000; // 15 min
  const maxAttempts = config.loginRateLimitMax || 5;

  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + window });
    return true; // allowed
  }
  if (record.count >= maxAttempts) return false; // blocked
  record.count++;
  return true; // allowed
}

// Clean up old rate limit records every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// ── In-memory refresh token store (production: use DB) ───────────────────────
const refreshTokens = new Map(); // token → { adminEmail, expiresAt }

// ── Public API ────────────────────────────────────────────────────────────────
const auth = {
  /**
   * Verify admin credentials and issue tokens.
   * Returns { accessToken, refreshToken } or throws an Error.
   */
  async login(email, password, ip) {
    if (!checkLoginRateLimit(ip)) {
      throw Object.assign(new Error('Too many login attempts. Try again in 15 minutes.'), { status: 429 });
    }

    if (email !== config.adminEmail) {
      logger.authFail(ip, email);
      throw Object.assign(new Error('Invalid credentials'), { status: 401 });
    }

    const bcryptLib = getBcrypt();
    if (bcryptLib && config.adminPasswordHash && config.adminPasswordHash.startsWith('$2')) {
      // Production: bcrypt compare
      const ok = await bcryptLib.compare(password, config.adminPasswordHash);
      if (!ok) {
        logger.authFail(ip, email);
        throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      }
    } else {
      // Dev fallback — plain text comparison (MUST be replaced in production)
      const LEGACY_PASS = 'Tayyabali77865';
      if (!crypto.timingSafeEqual(Buffer.from(password), Buffer.from(LEGACY_PASS))) {
        logger.authFail(ip, email);
        throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      }
      logger.warn('Using legacy plaintext password — set ADMIN_PASSWORD_HASH in .env for production');
    }

    const now = Math.floor(Date.now() / 1000);
    const accessToken = sign({
      sub: email,
      role: 'admin',
      iat: now,
      exp: now + 24 * 60 * 60, // 24 hours
    });

    const refreshToken = crypto.randomBytes(48).toString('hex');
    refreshTokens.set(refreshToken, {
      adminEmail: email,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    logger.info('admin_login', { email, ip });
    return { accessToken, refreshToken };
  },

  /**
   * Verify an access token. Returns the payload or null.
   */
  verifyToken(token) {
    return verify(token);
  },

  /**
   * Issue a new access token using a valid refresh token.
   */
  refresh(refreshToken) {
    const record = refreshTokens.get(refreshToken);
    if (!record || Date.now() > record.expiresAt) {
      refreshTokens.delete(refreshToken);
      throw Object.assign(new Error('Invalid or expired refresh token'), { status: 401 });
    }
    const now = Math.floor(Date.now() / 1000);
    const accessToken = sign({
      sub: record.adminEmail,
      role: 'admin',
      iat: now,
      exp: now + 24 * 60 * 60,
    });
    return { accessToken };
  },

  /**
   * Revoke a refresh token (logout).
   */
  logout(refreshToken) {
    refreshTokens.delete(refreshToken);
  },

  /**
   * Extract JWT from cookie string.
   */
  extractTokenFromCookies(cookieHeader) {
    if (!cookieHeader) return null;
    const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith('mb_token='));
    return match ? match.slice('mb_token='.length) : null;
  },

  /**
   * Build Set-Cookie headers for login response.
   */
  buildCookies(accessToken, refreshToken) {
    const secure = config.isProduction ? '; Secure' : '';
    return [
      `mb_token=${accessToken}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=86400`,
      `mb_refresh=${refreshToken}; HttpOnly; SameSite=Strict; Path=/api/v1/auth${secure}; Max-Age=604800`,
    ];
  },

  /**
   * Build clear-cookie headers for logout.
   */
  clearCookies() {
    return [
      'mb_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      'mb_refresh=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0',
    ];
  },

  /**
   * Utility: generate a bcrypt hash for a password (used during setup).
   */
  async hashPassword(password) {
    const bcryptLib = getBcrypt();
    if (!bcryptLib) throw new Error('bcryptjs not installed');
    return bcryptLib.hash(password, 12);
  },
};

module.exports = auth;
