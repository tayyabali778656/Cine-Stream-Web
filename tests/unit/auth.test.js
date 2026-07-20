'use strict';

/**
 * Auth Service Unit Tests
 * Tests: JWT sign/verify, cookie extraction, rate limiting, login flow
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Set required env vars before loading config
process.env.JWT_SECRET = 'test_jwt_secret_12345';
process.env.ADMIN_EMAIL = 'test@example.com';
process.env.ADMIN_PASSWORD_HASH = '';
process.env.NODE_ENV = 'test';

const auth = require('../../services/auth');

test('Auth Service Unit Tests', async (t) => {
  await t.test('extractTokenFromCookies: extracts mb_token correctly', () => {
    const cookieHeader = 'other_cookie=123; mb_token=my_jwt_token_abc; another=456';
    const extracted = auth.extractTokenFromCookies(cookieHeader);
    assert.equal(extracted, 'my_jwt_token_abc');
  });

  await t.test('extractTokenFromCookies: returns null when cookie is missing', () => {
    assert.equal(auth.extractTokenFromCookies(''), null);
    assert.equal(auth.extractTokenFromCookies(null), null);
  });

  await t.test('extractTokenFromCookies: returns null when mb_token not present', () => {
    const cookieHeader = 'session_id=abc123; user_id=xyz';
    assert.equal(auth.extractTokenFromCookies(cookieHeader), null);
  });

  await t.test('verifyToken: returns null for invalid token', () => {
    assert.equal(auth.verifyToken('not.a.valid.jwt'), null);
    assert.equal(auth.verifyToken(null), null);
    assert.equal(auth.verifyToken(''), null);
    assert.equal(auth.verifyToken('a.b'), null); // too few parts
  });

  await t.test('verifyToken: returns null for tampered token', () => {
    // Build a valid structure but with a wrong signature (same length as real sig).
    // Header + payload are real base64url; signature is wrong but same length.
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'test@example.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    // Use a known-length invalid signature (43 chars of 'X' padded to base64url length)
    const fakeSignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const tamperedToken = `${header}.${payload}.${fakeSignature}`;
    const result = auth.verifyToken(tamperedToken);
    assert.equal(result, null);
  });

  await t.test('buildCookies: returns two Set-Cookie headers', () => {
    const cookies = auth.buildCookies('access_token_123', 'refresh_token_456');
    assert.equal(cookies.length, 2);
    assert.ok(cookies[0].startsWith('mb_token=access_token_123'));
    assert.ok(cookies[1].startsWith('mb_refresh=refresh_token_456'));
  });

  await t.test('clearCookies: returns two clear-cookie headers', () => {
    const cookies = auth.clearCookies();
    assert.equal(cookies.length, 2);
    assert.ok(cookies[0].includes('Max-Age=0'));
    assert.ok(cookies[1].includes('Max-Age=0'));
  });

  await t.test('login: throws 401 for wrong email', async () => {
    await assert.rejects(
      () => auth.login('wrong@example.com', 'password', '127.0.0.1'),
      (err) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
  });

  await t.test('login: throws 429 after rate limit exceeded', async () => {
    const ip = '192.168.99.1'; // Use unique IP to avoid affecting other tests
    // Exhaust the rate limit (5 attempts by default)
    for (let i = 0; i < 5; i++) {
      try { await auth.login('wrong@example.com', 'bad', ip); } catch { /* expected */ }
    }
    // 6th attempt should be rate-limited
    await assert.rejects(
      () => auth.login('any@example.com', 'any', ip),
      (err) => {
        assert.equal(err.status, 429);
        return true;
      }
    );
  });

  await t.test('refresh: throws 401 for invalid refresh token', () => {
    assert.throws(
      () => auth.refresh('nonexistent_refresh_token'),
      (err) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
  });

  await t.test('logout: safely handles non-existent token', () => {
    // Should not throw
    assert.doesNotThrow(() => auth.logout('nonexistent_token'));
  });
});
