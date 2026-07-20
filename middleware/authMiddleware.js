'use strict';

/**
 * middleware/authMiddleware.js — JWT cookie verification middleware
 *
 * Protects state-changing API endpoints (POST, DELETE) by verifying
 * the HTTP-only JWT cookie set during admin login.
 *
 * Returns 401 if the token is missing, invalid, or expired.
 * Attaches { sub, role } to req._auth on success.
 */

const auth = require('../services/auth');
const logger = require('../utils/logger');

/**
 * requireAuth(req, res)
 * Returns true if authorized, false if it sent a 401 response.
 */
function requireAuth(req, res) {
  const token = auth.extractTokenFromCookies(req.headers.cookie || '');
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return false;
  }

  const payload = auth.verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    logger.warn('unauthorized_api_access', { ip, path: req.url });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return false;
  }

  req._auth = payload;
  return true;
}

module.exports = { requireAuth };
