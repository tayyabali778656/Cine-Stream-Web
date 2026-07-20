'use strict';

/**
 * serve.js — Production-grade HTTP server
 *
 * Responsibilities:
 *  - Static file serving with ETag + Cache-Control + Gzip compression
 *  - Versioned REST API (/api/v1/) with auth protection on mutations
 *  - Strict-whitelist HTTPS proxy (/proxy)
 *  - Security headers, CORS, rate limiting (via middleware)
 *  - Health endpoint (/health)
 *  - Dynamic sitemap (/sitemap.xml) and robots.txt
 *  - Request logging with timing
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const config = require('./config');
const logger = require('./utils/logger');
const { connectDB, getCollection, isConnected } = require('./db');
const liveSvc = require('./services/toonstreamLive');
const auth = require('./services/auth');
const cache = require('./services/cache');
const catalogSvc = require('./services/catalogService');
const queue = require('./services/queue');
const sitemapSvc = require('./services/sitemapService');
const { requireAuth } = require('./middleware/authMiddleware');
const { applySecurityHeaders, applyCors, applyRateLimit } = require('./middleware/security');

const PORT = config.port;
const PUBLIC_DIR = __dirname;

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// MIME types eligible for Gzip compression
const COMPRESSIBLE = new Set([
  'text/html; charset=utf-8',
  'text/css; charset=utf-8',
  'text/javascript; charset=utf-8',
  'application/json; charset=utf-8',
  'application/json',
  'image/svg+xml',
  'text/plain; charset=utf-8',
  'application/xml; charset=utf-8',
]);

// Cache-Control values per file type
const CACHE_CONTROL = {
  '.html': 'no-store, no-cache, must-revalidate, max-age=0',
  '.css': 'no-store, no-cache, must-revalidate, max-age=0',
  '.js': 'no-store, no-cache, must-revalidate, max-age=0',
  '.json': 'no-store', // catalog JSONs should NOT be cached by browser
  '.png': 'public, max-age=604800',
  '.jpg': 'public, max-age=604800',
  '.webp': 'public, max-age=604800',
  '.ico': 'public, max-age=604800',
  '.svg': 'public, max-age=86400',
  '.woff2': 'public, max-age=31536000, immutable',
  '.woff': 'public, max-age=31536000, immutable',
};

// ETag cache: path → { etag, mtime }
const etagCache = new Map();

// ── Allowed API collections ───────────────────────────────────────────────────
const ALLOWED_COLLECTIONS = config.allowedCollections;
// Map hyphenated route names to underscore DB collection names
const routeToCollection = (name) => name.replace(/-/g, '_');

// ── Helper: read request body as string ──────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1_000_000) { // 1MB body size limit
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── Helper: send JSON response ────────────────────────────────────────────────
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ── Helper: validate and sanitize incoming DB document ───────────────────────
function sanitizeDoc(doc, depth = 0) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    if (depth === 0) throw new Error('Body must be a JSON object');
    return doc; // Primitive value — safe as-is
  }
  if (depth > 5) return {}; // Guard against deeply nested objects

  // Remove MongoDB operator keys to prevent NoSQL injection (recursive)
  for (const key of Object.keys(doc)) {
    if (key.startsWith('$') || key.startsWith('.')) {
      delete doc[key];
    } else if (typeof doc[key] === 'object' && doc[key] !== null) {
      // Recursively sanitize nested objects
      doc[key] = sanitizeDoc(doc[key], depth + 1);
    } else if (typeof doc[key] === 'string' && doc[key].length > 10_000) {
      // Limit string field lengths to prevent DoS
      doc[key] = doc[key].slice(0, 10_000);
    }
  }
  return doc;
}

// ── Helper: compress body with Gzip if client supports it ────────────────────
function compressAndSend(req, res, body, contentType, extraHeaders = {}) {
  const accepts = req.headers['accept-encoding'] || '';
  const canGzip = COMPRESSIBLE.has(contentType) && accepts.includes('gzip');

  res.setHeader('Vary', 'Accept-Encoding');
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (canGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', contentType);
    zlib.gzip(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), (err, compressed) => {
      if (err) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.setHeader('Content-Length', compressed.length);
      res.writeHead(200);
      res.end(compressed);
    });
  } else {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buf.length);
    res.writeHead(200);
    res.end(buf);
  }
}

// ── Proxy: whitelist enforcement (SSRF-safe, streaming-open) ─────────────────
// Blocks all private/loopback addresses to prevent SSRF attacks.
// Allows any public internet domain so streaming CDN redirects always resolve.
function isProxyAllowed(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();

    // Block loopback and private network addresses (SSRF prevention)
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      return false;
    }

    // Allow any other public internet host
    // (streaming CDNs redirect to many dynamic domains — we can't whitelist them all)
    return true;
  } catch {
    return false;
  }
}

// ── Proxy: recursive redirect follower ───────────────────────────────────────
function proxyFetch(url, method = 'GET', bodyStr = '', depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many redirects')); return; }
    if (!isProxyAllowed(url)) { reject(new Error('Target domain not in whitelist')); return; }

    const reqModule = url.startsWith('https') ? https : http;
    const options = {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0',
        'Referer': 'https://toonstream.vip/',
      },
      timeout: 15_000,
    };
    if (method === 'POST') {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const proxyReq = reqModule.request(url, options, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let nextUrl = proxyRes.headers.location;
        if (!nextUrl.startsWith('http')) {
          const parsed = new URL(url);
          nextUrl = parsed.origin + nextUrl;
        }
        resolve(proxyFetch(nextUrl, method, bodyStr, depth + 1));
        return;
      }
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => resolve({ data, finalUrl: url, statusCode: proxyRes.statusCode }));
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('Proxy request timed out')); });
    if (method === 'POST') proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Dynamic Sitemap ───────────────────────────────────────────────────────────
async function buildSitemap() {
  const baseUrl = 'https://cinestream.watch';
  const today = new Date().toISOString().split('T')[0];

  const staticPages = [
    { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'daily', lastmod: today },
    { loc: `${baseUrl}/about.html`, priority: '0.6', changefreq: 'monthly', lastmod: today },
    { loc: `${baseUrl}/contact.html`, priority: '0.5', changefreq: 'monthly', lastmod: today },
    { loc: `${baseUrl}/privacy.html`, priority: '0.3', changefreq: 'yearly', lastmod: today },
    { loc: `${baseUrl}/disclaimer.html`, priority: '0.3', changefreq: 'yearly', lastmod: today },
  ];

  let dynamicPages = [];

  try {
    if (isConnected()) {
      const animeItems = await getCollection('anime').find({}).toArray();
      for (const item of animeItems) {
        dynamicPages.push({
          loc: `${baseUrl}/media/${item.type === 'movie' ? 'movie' : 'tv'}/${item.id}`,
          priority: '0.8',
          changefreq: 'weekly',
          lastmod: today,
          image: item.poster,
          imageTitle: item.title,
          imageCaption: (item.description || '').slice(0, 200),
        });
      }
    }
  } catch (err) {
    logger.warn('sitemap_build_error', { message: err.message });
  }

  const urlEntries = [...staticPages, ...dynamicPages].map(p => {
    const imageTag = p.image ? `
    <image:image>
      <image:loc>${p.image}</image:loc>
      <image:title>${(p.imageTitle || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</image:title>
      ${p.imageCaption ? `<image:caption>${p.imageCaption.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</image:caption>` : ''}
    </image:image>` : '';
    return `
  <url>
    <loc>${p.loc}</loc>
    <lastmod>${p.lastmod || today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>${imageTag}
  </url>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">${urlEntries}
</urlset>`;
}


// ── API v1 Router ─────────────────────────────────────────────────────────────
async function handleApiV1(req, res, pathname) {
  // ── ToonStream Custom DB API Endpoints ─────────────────────────────────────
  if (pathname === '/api/v1/search' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) { sendJson(res, 200, []); return; }
    try {
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const data = await liveSvc.getLiveAnimeList('', page, '', '', q);
      sendJson(res, 200, data.results || []);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/v1/anime/details' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const id = url.searchParams.get('id') || '';
    const slug = url.searchParams.get('slug') || '';
    try {
      const anime = await liveSvc.getLiveAnimeDetails(id, slug);
      if (!anime) {
        sendJson(res, 404, { error: 'Anime not found' });
        return;
      }
      sendJson(res, 200, { ...anime, related: [], recommendations: [] });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/v1/episodes' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const animeId = url.searchParams.get('animeId') || '';
    const animeSlug = url.searchParams.get('animeSlug') || '';
    const season = parseInt(url.searchParams.get('season') || '1', 10);
    const episode = parseInt(url.searchParams.get('episode') || '1', 10);
    const slug = animeSlug || (animeId ? animeId.replace('toon_', '') : '');

    // Per-episode cache — getLiveEpisodes only scrapes sources for the specific S+E requested.
    // Using a slug-level cache would store empty sources for all other episodes.
    const cacheKey = `eps_${slug}_${season}_${episode}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      sendJson(res, 200, cachedData);
      return;
    }

    try {
      // Parallelize admin lookup + details — both are independent, no reason to be sequential
      const [adminEntry, details] = await Promise.all([
        (async () => {
          try {
            const adminCollection = getCollection('admin_store');
            if (!adminCollection) return null;
            return await adminCollection.findOne({
              $or: [
                { id: animeId },
                { id: `toon_${slug}` },
                { toonstreamId: animeId },
                { toonstreamSlug: slug }
              ]
            });
          } catch (dbErr) {
            logger.warn('Failed to query admin_store in episodes API:', dbErr.message);
            return null;
          }
        })(),
        (async () => {
          const detailsCacheKey = `details_${animeId}_${slug}`;
          let det = cache.get(detailsCacheKey);
          if (!det) {
            det = await liveSvc.getLiveAnimeDetails(animeId, slug);
            if (det) cache.set(detailsCacheKey, det, 30 * 60 * 1000);
          }
          return det;
        })()
      ]);

      if (details && details.type === 'movie') {
        const movieEpisodes = [{
          id: `ep_${slug}_1x1`,
          animeId: animeId,
          animeSlug: slug,
          season: 1,
          episode: 1,
          title: details.title,
          sources: details.movieSources || []
        }];
        cache.set(cacheKey, movieEpisodes, 15 * 60 * 1000);
        sendJson(res, 200, movieEpisodes);
        return;
      }

      let episodes = [];
      try {
        episodes = await liveSvc.getLiveEpisodes(slug, season, episode);
      } catch (epErr) {
        logger.warn(`getLiveEpisodes failed for ${slug}:`, epErr.message);
      }

      if (!Array.isArray(episodes)) episodes = [];

      // Merge custom episode links from admin store
      if (adminEntry && adminEntry.customLinks) {
        for (const [key, customUrl] of Object.entries(adminEntry.customLinks)) {
          const match = key.match(/^S(\d+)E(\d+)$/i);
          if (match) {
            const s = parseInt(match[1], 10);
            const e = parseInt(match[2], 10);
            const existingEp = episodes.find(ep => ep.season === s && ep.episode === e);
            if (existingEp) {
              existingEp.sources = existingEp.sources || [];
              if (!existingEp.sources.some(src => src.url === customUrl)) {
                existingEp.sources.unshift({ url: customUrl, type: 'iframe', label: 'Primary Link (Custom)', trusted: true });
              }
            } else {
              episodes.push({
                id: `ep_${slug}_${s}x${e}`,
                animeId: animeId || `toon_${slug}`,
                animeSlug: slug, season: s, episode: e,
                title: `S${s}E${e} (Custom Link)`, url: '',
                sources: [{ url: customUrl, type: 'iframe', label: 'Primary Link (Custom)', trusted: true }]
              });
            }
          }
        }
        episodes.sort((a, b) => a.season !== b.season ? a.season - b.season : a.episode - b.episode);
      }

      cache.set(cacheKey, episodes, 15 * 60 * 1000);
      sendJson(res, 200, episodes);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }



  if (pathname === '/api/v1/anime' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const filter = url.searchParams.get('filter') || 'trending';
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const genre = url.searchParams.get('genre') || '';
    const type = url.searchParams.get('type') || '';

    try {
      const data = await liveSvc.getLiveAnimeList(filter, page, type, genre);
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }


  // ── Auth routes ────────────────────────────────────────────────────────────
  if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      const { email, password } = body;
      if (!email || !password) { sendJson(res, 400, { error: 'Email and password required' }); return; }
      const tokens = await auth.login(email.trim().toLowerCase(), password, ip);
      const cookies = auth.buildCookies(tokens.accessToken, tokens.refreshToken);
      res.setHeader('Set-Cookie', cookies);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.clearCookies());
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/v1/auth/verify' && req.method === 'GET') {
    const token = auth.extractTokenFromCookies(req.headers.cookie || '');
    const payload = token ? auth.verifyToken(token) : null;
    if (payload) {
      sendJson(res, 200, { authenticated: true, sub: payload.sub });
    } else {
      sendJson(res, 401, { authenticated: false });
    }
    return;
  }

  if (pathname === '/api/v1/admin-reset' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      await getCollection('admin_store').deleteMany({});
      await getCollection('broken_videos').deleteMany({});
      await getCollection('hindi_dubbed').deleteMany({});
      await getCollection('missing_catalog').deleteMany({});
      await getCollection('hidden_items').deleteMany({});
      
      cache.deleteByPrefix('db_');
      cache.deleteByPrefix('eps_');
      cache.deleteByPrefix('details_');
      
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ── Catalog check (replaces client downloading 3.7MB JSON) ────────────────
  if (pathname === '/api/v1/check-catalog' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { title, id } = body;
      if (!title) { sendJson(res, 400, { error: 'title is required' }); return; }
      const result = catalogSvc.checkCatalog(title);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid request body' });
    }
    return;
  }

  // ── NetMirror Direct Video URL Resolver ───────────────────────────────
  if (pathname === '/api/v1/resolve-netmirror') {
    const params = new URLSearchParams((req.url || '').split('?')[1] || '');
    const subjectid = params.get('id');
    const dp = params.get('dp');
    const title = params.get('title') || 'Video';
    const se = params.get('se') || '0';
    const ep = params.get('ep') || '0';

    if (!subjectid || !dp) {
      sendJson(res, 400, { error: 'Missing parameters' });
      return;
    }

    try {
      const crypto = require('crypto');
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'net###@@sss').update(String(ts)).digest('hex');

      const btoaTitle = Buffer.from(title).toString('base64');

      // Use random server between 1 and 6
      const serverNum = Math.floor(Math.random() * 6) + 1;
      const speedHosts = {
        1: 'speed.watch22.shop',
        2: 'play.watch22.shop',
        3: 'play.watch21.shop',
        4: 'speed.watch22.shop',
        5: 'test.watch22.shop',
        6: 'playnew.watch21.shop'
      };
      const host = speedHosts[serverNum] || 'speed.watch22.shop';

      const targetUrl = `https://${host}/play/watchbox.php?id=${subjectid}&se=${se}&ep=${ep}&dp=${encodeURIComponent(dp)}&na=${btoaTitle}&ts=${ts}&sig=${sig}&exten=0`;

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://netmirror.global/'
        }
      });

      const html = await response.text();

      // Extract all .mp4 links
      const matches = html.match(/https?:\/\/[^\s\x22\x27]+\.mp4\?[^\s\x22\x27]+/g) || [];

      if (matches.length > 0) {
        // Prioritize hakunaymatata/hakunamata resource URLs, then any hakunaymatata link, then resourceUrl, then first match
        const hakunaResource = matches.find(url => (url.includes('hakunaymatata') || url.includes('hakunamata')) && url.includes('/resource/'));
        const hakunaAny = matches.find(url => url.includes('hakunaymatata') || url.includes('hakunamata'));
        const resourceUrl = matches.find(url => url.includes('/resource/'));

        const finalUrl = hakunaResource || hakunaAny || resourceUrl || matches[0];
        sendJson(res, 200, { url: finalUrl });
      } else {
        const fallbackMatches = html.match(/https?:\/\/[^\s\x22\x27]+\.mp4/g) || [];
        const hakunaFallback = fallbackMatches.find(url => url.includes('hakunaymatata') || url.includes('hakunamata'));
        if (hakunaFallback || fallbackMatches.length > 0) {
          sendJson(res, 200, { url: hakunaFallback || fallbackMatches[0] });
        } else {
          sendJson(res, 404, { error: 'No video stream found in NetMirror page' });
        }
      }
    } catch (err) {
      logger.error('NetMirror resolution error:', err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ── CRUD collection routes ─────────────────────────────────────────────────
  // Strip /api/v1/ prefix → collection name
  const collectionName = pathname.slice('/api/v1/'.length);
  if (!ALLOWED_COLLECTIONS.has(collectionName)) {
    sendJson(res, 404, { error: 'Collection not found' });
    return;
  }

  // Protect state-changing methods
  if (req.method === 'POST' || req.method === 'DELETE') {
    // Ordinary users should be allowed to report missing or broken videos.
    // They are not logged in as admin, so anonymous POST to these collections is allowed.
    const isAnonymousAllowed = req.method === 'POST' &&
      (collectionName === 'missing-catalog' || collectionName === 'broken-videos');

    if (!isAnonymousAllowed) {
      if (!requireAuth(req, res)) return;
    }
  }

  let collection;
  try {
    collection = getCollection(routeToCollection(collectionName));
  } catch {
    if (req.method === 'GET') {
      sendJson(res, 503, { error: 'Database not available' });
    } else {
      sendJson(res, 202, { success: false, warning: 'Database not available yet' });
    }
    return;
  }

  // Note: url is parsed inside each method block below to avoid shadowing
  const dbStart = Date.now();

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const forceFresh = url.searchParams.has('_'); // client sent ?_=timestamp to bypass cache
    const cacheKey = `db_${collectionName}`;
    if (!forceFresh) {
      const cached = cache.get(cacheKey);
      if (cached) { sendJson(res, 200, cached); return; }
    }
    try {
      const data = await collection.find({}).toArray();
      cache.set(cacheKey, data, 5 * 60 * 1000); // 5-min DB cache
      logger.db('find', collectionName, Date.now() - dbStart);
      sendJson(res, 200, data);
    } catch (err) {
      logger.db('find', collectionName, Date.now() - dbStart, err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const doc = sanitizeDoc(JSON.parse(rawBody));
      const id = doc.id;
      cache.deleteByPrefix(`db_${collectionName}`); // invalidate cache
      if (collectionName === 'admin-store') {
        cache.deleteByPrefix('eps_');
        cache.deleteByPrefix('details_');
      }
      if (id) {
        delete doc._id;
        await collection.updateOne({ id }, { $set: doc }, { upsert: true });
        logger.db('upsert', collectionName, Date.now() - dbStart);
        // Trigger sitemap rebuild whenever media content changes
        if (collectionName === 'admin-store') sitemapSvc.triggerRegen(`upsert_${collectionName}`);
        sendJson(res, 200, { success: true });
      } else {
        const result = await collection.insertOne(doc);
        logger.db('insert', collectionName, Date.now() - dbStart);
        // Trigger sitemap rebuild for new media items
        if (collectionName === 'admin-store') sitemapSvc.triggerRegen(`insert_${collectionName}`);
        sendJson(res, 201, { success: true, insertedId: result.insertedId });
      }
    } catch (err) {
      logger.db('write', collectionName, Date.now() - dbStart, err);
      const status = err.status || (err.message.includes('JSON') ? 400 : 500);
      sendJson(res, status, { error: err.message });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const id = url.searchParams.get('id');
    if (!id) { sendJson(res, 400, { error: 'Missing id parameter' }); return; }
    try {
      cache.deleteByPrefix(`db_${collectionName}`); // invalidate cache
      if (collectionName === 'admin-store') {
        cache.deleteByPrefix('eps_');
        cache.deleteByPrefix('details_');
      }
      const result = await collection.deleteOne({ id });
      logger.db('delete', collectionName, Date.now() - dbStart);
      // Trigger sitemap rebuild when media is removed
      if (collectionName === 'admin-store') sitemapSvc.triggerRegen(`delete_${collectionName}`);
      sendJson(res, 200, { success: true, deletedCount: result.deletedCount });
    } catch (err) {
      logger.db('delete', collectionName, Date.now() - dbStart, err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

// ── Static File Handler ───────────────────────────────────────────────────────
function handleStatic(req, res, filePath, ext) {
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const cacheControl = CACHE_CONTROL[ext] || 'public, max-age=3600';

  // ETag support
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const etagData = etagCache.get(filePath);
  let etag;
  if (etagData && etagData.mtime === stat.mtimeMs) {
    etag = etagData.etag;
  } else {
    etag = `"${crypto.createHash('md5').update(String(stat.mtimeMs) + filePath).digest('hex')}"`;
    etagCache.set(filePath, { etag, mtime: stat.mtimeMs });
  }

  // Conditional request — return 304 if content unchanged
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  // Block direct browser access to raw catalog JSONs (3.7MB files)
  if (filePath.includes('_catalog.json')) {
    sendJson(res, 403, { error: 'Direct catalog access is disabled. Use /api/v1/check-catalog' });
    return;
  }

  // Block access to sensitive server-side files
  const relativePath = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, '/');
  const blockedPaths = ['db.js', 'config.js', 'serve.js', '.env', 'services/', 'middleware/', 'utils/'];
  if (blockedPaths.some(b => relativePath.startsWith(b))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    compressAndSend(req, res, content, contentType, {
      'ETag': etag,
      'Cache-Control': cacheControl,
      'Last-Modified': stat.mtime.toUTCString(),
    });
  });
}

// ── Main request handler ──────────────────────────────────────────────────────
// Extracted to a named function so Vercel's @vercel/node can import it as a
// serverless handler. Local dev still uses http.createServer + .listen().
const requestHandler = async (req, res) => {
  const startMs = Date.now();

  // Apply security headers to every response
  applySecurityHeaders(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    if (!applyCors(req, res)) return;
    res.writeHead(204);
    res.end();
    logger.request(req, 204, Date.now() - startMs);
    return;
  }

  // Extract pathname early so we can use it in CORS logic
  const pathname = (req.url || '').split('?')[0];

  // Apply CORS — only BLOCK for API/proxy routes (origin enforcement).
  // Static files (HTML, CSS, JS, manifest.json, images…) are public assets;
  // we just set permissive headers so PWA manifests, fonts etc. all load fine.
  if (pathname.startsWith('/api/') || pathname.startsWith('/proxy') || pathname.startsWith('/iframe-proxy')) {
    if (!applyCors(req, res)) {
      logger.request(req, 403, Date.now() - startMs);
      return;
    }
  } else {
    // Open CORS for all static/public assets
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  // Apply rate limiting (skip for static assets)
  if (pathname.startsWith('/api/') || pathname.startsWith('/proxy')) {
    if (!applyRateLimit(req, res, pathname)) {
      logger.request(req, 429, Date.now() - startMs);
      return;
    }
  }

  let statusCode = 200;

  try {
    // ── Health endpoint (protected — requires admin token or X-Health-Secret) ──
    if (pathname === '/health') {
      // Allow if: valid admin JWT cookie OR correct X-Health-Secret header
      const healthSecret = process.env.HEALTH_SECRET || '';
      const requestSecret = req.headers['x-health-secret'] || '';
      const token = require('./services/auth').extractTokenFromCookies(req.headers.cookie || '');
      const payload = token ? require('./services/auth').verifyToken(token) : null;
      const isAdmin = payload && payload.role === 'admin';
      const hasSecret = healthSecret && requestSecret === healthSecret;

      if (!isAdmin && !hasSecret) {
        sendJson(res, 401, { error: 'Unauthorized. Provide admin token or X-Health-Secret header.' });
        logger.request(req, 401, Date.now() - startMs);
        return;
      }

      const healthData = {
        status: isConnected() ? 'ok' : 'degraded',
        db: isConnected() ? 'connected' : 'disconnected',
        catalog: catalogSvc.getStats(),
        queue: queue.getStats(),
        cache: cache.stats(),
        metrics: logger.getMetrics(),
        version: '2.0.0',
        timestamp: new Date().toISOString(),
      };
      sendJson(res, 200, healthData);
      statusCode = 200;
      logger.request(req, statusCode, Date.now() - startMs);
      return;
    }

    // ── Robots.txt ────────────────────────────────────────────────────────
    if (pathname === '/robots.txt') {
      const SITE = 'https://cinestream.watch';
      const robots = [
        '# CineStream robots.txt — https://cinestream.watch',
        '# Last updated: ' + new Date().toISOString().split('T')[0],
        '',
        '# Allow all legitimate crawlers',
        'User-agent: *',
        'Allow: /',
        'Allow: /about.html',
        'Allow: /contact.html',
        'Allow: /privacy.html',
        'Allow: /disclaimer.html',
        'Allow: /images/',
        'Allow: /public/',
        'Allow: /sitemap.xml',
        'Allow: /sitemap-index.xml',
        'Allow: /manifest.json',
        '',
        '# Block admin, API and private areas',
        'Disallow: /tayyab/',
        'Disallow: /api/',
        'Disallow: /proxy',
        'Disallow: /health',
        'Disallow: /iframe-proxy',
        '',
        '# Google Image Bot — allow images',
        'User-agent: Googlebot-Image',
        'Allow: /images/',
        'Allow: /public/',
        '',
        '# Googlebot — no crawl delay',
        'User-agent: Googlebot',
        'Allow: /',
        'Disallow: /tayyab/',
        'Disallow: /api/',
        '',
        '# Bing — mild crawl delay',
        'User-agent: Bingbot',
        'Allow: /',
        'Crawl-delay: 5',
        '',
        '# Block bad bots',
        'User-agent: AhrefsBot',
        'Disallow: /',
        '',
        'User-agent: SemrushBot',
        'Disallow: /',
        '',
        '# Sitemaps',
        `Sitemap: ${SITE}/sitemap.xml`,
        `Sitemap: ${SITE}/sitemap-index.xml`,
      ].join('\n');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(robots);
      logger.request(req, 200, Date.now() - startMs);
      return;
    }

    // ── Dynamic env.js — serves frontend config from environment variables ───
    // This lets Vercel serve env.js without the file being in git
    if (pathname === '/env.js') {
      const tmdbKey = process.env.TMDB_API_KEY || '';
      const streamUrl = process.env.STREAM_PLAYER_URL || 'https://gemma416okl.com/play/';
      const envContent = `// Auto-generated by server — do not edit manually\nconst ENV = {\n  TMDB_API_KEY: '${tmdbKey}',\n  STREAM_PLAYER_URL: '${streamUrl}'\n};\n`;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.writeHead(200);
      res.end(envContent);
      logger.request(req, 200, Date.now() - startMs);
      return;
    }

    // ── manifest.json — PWA manifest with correct MIME type ──────────────────
    if (pathname === '/manifest.json') {
      const manifestPath = path.join(PUBLIC_DIR, 'manifest.json');
      try {
        const content = fs.readFileSync(manifestPath, 'utf8');
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
      logger.request(req, 200, Date.now() - startMs);
      return;
    }

    // ── Static Sitemap Files (pre-generated by npm run generate-sitemap) ─────
    // Handles: /sitemap.xml, /sitemap-2.xml, /sitemap-3.xml, /sitemap-index.xml
    const sitemapMatch = pathname.match(/^\/(sitemap(-\d+)?\.xml|sitemap-index\.xml)$/);
    if (sitemapMatch) {
      const filename = pathname.slice(1); // strip leading /
      const staticPath = path.join(PUBLIC_DIR, filename);

      if (fs.existsSync(staticPath)) {
        // Serve the pre-generated static file — fastest path, no API calls needed
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        fs.createReadStream(staticPath).pipe(res);
        logger.request(req, 200, Date.now() - startMs);
        return;
      }

      // Fallback: if sitemap.xml is missing, build it dynamically (first-run scenario)
      if (filename === 'sitemap.xml') {
        const cached = cache.get('sitemap_xml');
        let xml = cached;
        if (!xml) {
          xml = await buildSitemap();
          cache.set('sitemap_xml', xml, 60 * 60 * 1000);
        }
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(xml);
        logger.request(req, 200, Date.now() - startMs);
        return;
      }

      // Fallback: sitemap-index.xml — return a minimal valid index
      if (filename === 'sitemap-index.xml') {
        const SITE = 'https://cinestream.watch';
        const today = new Date().toISOString().split('T')[0];
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>${SITE}/sitemap.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n</sitemapindex>`;
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(xml);
        logger.request(req, 200, Date.now() - startMs);
        return;
      }

      // Numbered chunk not found → 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Sitemap chunk not found');
      return;
    }


    // ── Versioned API v1 ──────────────────────────────────────────────────
    if (pathname.startsWith('/api/v1/')) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      await handleApiV1(req, res, pathname);
      logger.request(req, res.statusCode || 200, Date.now() - startMs);
      return;
    }

    // ── Legacy /api/ → redirect to v1 (uses 308 to preserve POST method & body) ──
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1/')) {
      const v1Path = pathname.replace('/api/', '/api/v1/');
      res.writeHead(308, { Location: v1Path });
      res.end();
      logger.request(req, 308, Date.now() - startMs);
      return;
    }

    // ── Proxy ─────────────────────────────────────────────────────────────
    if (pathname === '/proxy') {
      const params = new URLSearchParams((req.url || '').split('?')[1] || '');
      const targetUrl = params.get('url');
      const method = params.get('method') || 'GET';
      const bodyStr = params.get('body') || '';

      if (!targetUrl || !targetUrl.startsWith('http')) {
        sendJson(res, 400, { error: 'Invalid url parameter' });
        logger.request(req, 400, Date.now() - startMs);
        return;
      }

      if (!isProxyAllowed(targetUrl)) {
        logger.warn('proxy_blocked', { url: targetUrl });
        sendJson(res, 403, { error: 'Target domain not in whitelist' });
        logger.request(req, 403, Date.now() - startMs);
        return;
      }

      const proxyStart = Date.now();
      try {
        const { data, finalUrl, statusCode: proxyStatus } = await proxyFetch(targetUrl, method, bodyStr);
        logger.proxy(targetUrl, proxyStatus, Date.now() - proxyStart);
        res.setHeader('Access-Control-Allow-Origin', '*');
        sendJson(res, 200, { content: data, finalUrl, statusCode: proxyStatus });
      } catch (e) {
        logger.warn('proxy_error', { url: targetUrl, error: e.message });
        sendJson(res, 500, { error: e.message });
        statusCode = 500;
      }
    }

    // ── Iframe Proxy to bypass X-Frame-Options ────────────────────────────
    if (pathname === '/iframe-proxy') {
      const params = new URLSearchParams((req.url || '').split('?')[1] || '');
      const targetUrl = params.get('url');

      if (!targetUrl || !targetUrl.startsWith('http')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid url');
        return;
      }

      // Helper to resolve HLS stream from streamruby/strmup/vidstreaming mirrors
      const resolveHlsStream = async (tUrl) => {
        let embedUrl = tUrl;
        let html = '';
        try {
          const res = await fetch(embedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': 'https://toon-stream.site/'
            }
          });
          html = await res.text();
        } catch (e) {
          return { hlsUrl: null, iframeUrl: null };
        }

        const iframeMatch = html.match(/<iframe[^>]*src="([^"]+)"/i);
        let iframeUrl = iframeMatch ? iframeMatch[1] : null;
        if (!iframeUrl) {
          if (tUrl.includes('rubystm.com') || tUrl.includes('strmup.to') || tUrl.includes('vidstreaming.xyz') || tUrl.includes('streamruby') || tUrl.includes('rubystm.to')) {
            iframeUrl = tUrl;
          } else {
            return { hlsUrl: null, iframeUrl: null };
          }
        }

        if (!iframeUrl.includes('rubystm.com') &&
          !iframeUrl.includes('strmup.to') &&
          !iframeUrl.includes('vidstreaming.xyz') &&
          !iframeUrl.includes('streamruby.com') &&
          !iframeUrl.includes('streamruby.net') &&
          !iframeUrl.includes('rubystm.to')) {
          return { hlsUrl: null, iframeUrl };
        }

        try {
          const parsedUrl = new URL(iframeUrl);
          const origin = parsedUrl.origin;
          const path = parsedUrl.pathname;

          let cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
          cleanPath = cleanPath.replace('.html', '');
          const code = cleanPath.split('/').pop().split('-').pop();
          if (!code) return { hlsUrl: null, iframeUrl };

          const postBody = `op=embed&file_code=${code}&auto=1&referer=https%3A%2F%2Ftoon-stream.site%2F`;
          const dlRes = await fetch(`${origin}/dl`, {
            method: 'POST',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': iframeUrl
            },
            body: postBody
          });

          const dlHtml = await dlRes.text();

          const startKeyword = 'eval(function(p,a,c,k,e,d)';
          const startIndex = dlHtml.indexOf(startKeyword);
          if (startIndex === -1) return { hlsUrl: null, iframeUrl };

          const evalParenStart = dlHtml.indexOf('(', startIndex);
          if (evalParenStart === -1) return { hlsUrl: null, iframeUrl };

          let parenCount = 1;
          let index = evalParenStart + 1;
          while (index < dlHtml.length && parenCount > 0) {
            const char = dlHtml[index];
            if (char === '(') parenCount++;
            else if (char === ')') parenCount--;
            index++;
          }
          if (parenCount !== 0) return { hlsUrl: null, iframeUrl };

          const evalContent = dlHtml.substring(evalParenStart + 1, index - 1);
          const closingBraceIndex = evalContent.indexOf('}');
          if (closingBraceIndex === -1) return { hlsUrl: null, iframeUrl };

          const argsStart = evalContent.indexOf('(', closingBraceIndex);
          if (argsStart === -1) return { hlsUrl: null, iframeUrl };

          const argsStr = evalContent.substring(argsStart + 1).trim();

          let p = '';
          let a = 0;
          let c = 0;
          let k = [];

          let quoteChar = argsStr[0];
          if (quoteChar !== "'" && quoteChar !== '"') return { hlsUrl: null, iframeUrl };

          let i = 1;
          while (i < argsStr.length) {
            if (argsStr[i] === '\\') {
              p += argsStr[i + 1];
              i += 2;
            } else if (argsStr[i] === quoteChar) {
              break;
            } else {
              p += argsStr[i];
              i++;
            }
          }
          i++;

          i = argsStr.indexOf(',', i);
          if (i === -1) return { hlsUrl: null, iframeUrl };
          i++;

          const nextComma1 = argsStr.indexOf(',', i);
          if (nextComma1 === -1) return { hlsUrl: null, iframeUrl };
          a = parseInt(argsStr.substring(i, nextComma1).trim(), 10);
          i = nextComma1 + 1;

          const nextComma2 = argsStr.indexOf(',', i);
          if (nextComma2 === -1) return { hlsUrl: null, iframeUrl };
          c = parseInt(argsStr.substring(i, nextComma2).trim(), 10);
          i = nextComma2 + 1;

          const kStartQuoteIndex = argsStr.indexOf(argsStr.match(/['"]/)?.[0] || "'", i);
          if (kStartQuoteIndex === -1) return { hlsUrl: null, iframeUrl };
          const kQuoteChar = argsStr[kStartQuoteIndex];

          let kStr = '';
          let j = kStartQuoteIndex + 1;
          while (j < argsStr.length) {
            if (argsStr[j] === '\\') {
              kStr += argsStr[j + 1];
              j += 2;
            } else if (argsStr[j] === kQuoteChar) {
              break;
            } else {
              kStr += argsStr[j];
              j++;
            }
          }

          k = kStr.split('|');

          let unpacked = p;
          let count = c;
          while (count--) {
            if (k[count]) {
              unpacked = unpacked.replace(new RegExp('\\b' + count.toString(a) + '\\b', 'g'), k[count]);
            }
          }

          const m3u8Match = unpacked.match(/https?:\/\/[^\s\x22\x27]+\.m3u8[^\s\x22\x27]*/i);
          return {
            hlsUrl: m3u8Match ? m3u8Match[0] : null,
            iframeUrl
          };
        } catch (e) {
          logger.warn('Failed to resolve streamruby HLS:', e.message);
          return { hlsUrl: null, iframeUrl };
        }
      };

      try {
        // Attempt to resolve the direct HLS stream first
        const result = await resolveHlsStream(targetUrl);
        if (result && result.hlsUrl) {
          logger.info('Resolved direct HLS stream for player proxy', { targetUrl, hlsUrl: result.hlsUrl });
          const cleanPlayerHtml = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <title>Clean Stream Player</title>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.10/dist/hls.min.js"></script>
              <style>
                body, html {
                  margin: 0; padding: 0; width: 100%; height: 100%;
                  background-color: #000; overflow: hidden;
                  display: flex; justify-content: center; align-items: center;
                  font-family: sans-serif;
                }
                video {
                  width: 100%; height: 100%;
                  outline: none;
                }
                #loading {
                  position: absolute;
                  color: #fff;
                  font-size: 1.1rem;
                  pointer-events: none;
                  transition: opacity 0.3s;
                  background: rgba(0, 0, 0, 0.7);
                  padding: 10px 20px;
                  border-radius: 20px;
                }
              </style>
            </head>
            <body>
              <div id="loading">Loading clean stream...</div>
              <video id="video" controls autoplay playsinline></video>
              <script>
                const video = document.getElementById('video');
                const loading = document.getElementById('loading');
                const videoSrc = ${JSON.stringify(result.hlsUrl)};

                video.onplaying = () => {
                  loading.style.opacity = '0';
                };

                if (Hls.isSupported()) {
                  const hls = new Hls({ maxMaxBufferLength: 30, enableWorker: true });
                  hls.loadSource(videoSrc);
                  hls.attachMedia(video);
                  hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.play().catch(() => {});
                  });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                  video.src = videoSrc;
                  video.addEventListener('canplay', function() {
                    video.play().catch(() => {});
                  });
                }
              </script>
            </body>
            </html>
          `;
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(cleanPlayerHtml);
          return;
        }

        // If resolution failed, but either the targetUrl or the resolved iframeUrl is a known streamruby/strmup mirror, do NOT load it in iframe
        const checkUrl = (urlStr) => {
          if (!urlStr) return false;
          return urlStr.includes('rubystm.com') || urlStr.includes('strmup.to') || urlStr.includes('vidstreaming.xyz') || urlStr.includes('streamruby') || urlStr.includes('rubystm.to');
        };
        const isMirror = checkUrl(targetUrl) || (result && checkUrl(result.iframeUrl));

        if (isMirror) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { background: #0b0b0b; color: #ffaa00; font-family: sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
                h3 { margin-bottom: 8px; color: #e50914; }
                p { color: #ccc; font-size: 0.9rem; }
              </style>
            </head>
            <body>
              <h3>Server Unavailable</h3>
              <p>This video link has expired or has been deleted from the host. Please choose another server.</p>
            </body>
            </html>
          `);
          return;
        }

        // Fallback to normal proxy
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://fmoviesunblocked.net/'
          }
        });

        let html = await response.text();
        const originUrl = new URL(targetUrl);
        const originBase = originUrl.origin;

        // Block popups, clickjacking, push notifications & redirects inside proxied iframe
        const adBlockScript = `
          <script>
            // Deep freeze/override window.open to completely block popups
            const noop = function() { return null; };
            window.open = noop;
            Object.defineProperty(window, 'open', { value: noop, writable: false, configurable: false });
            window.alert = noop;
            window.confirm = function() { return false; };
            window.prompt = noop;
            
            // Prevent frame-busting (redirection of parent page)
            if (window.self !== window.top) {
              try {
                Object.defineProperty(window, 'top', { get: function() { return window.self; } });
                Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
              } catch (e) {}
            }
            
            // Block Notification prompts
            if (window.Notification) {
              window.Notification.requestPermission = function() {
                return Promise.resolve('denied');
              };
              Object.defineProperty(window.Notification, 'permission', {
                get: function() { return 'denied'; }
              });
            }
            
            // Block Service Worker registrations
            if (navigator.serviceWorker) {
              Object.defineProperty(navigator, 'serviceWorker', {
                get: function() { return null; }
              });
            }

            // Block dynamic element creation of pop-under anchor tags
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName, options) {
              const el = originalCreateElement.call(document, tagName, options);
              if (tagName.toLowerCase() === 'a') {
                const originalClick = el.click;
                el.click = function() {
                  const href = el.href || '';
                  const target = el.target || '';
                  if (target === '_blank' || href.includes('ad') || href.includes('pop') || href.includes('click') || href.includes('syndication')) {
                    console.log('[AdBlock] Blocked dynamic anchor navigation:', href);
                    return;
                  }
                  return originalClick.apply(el, arguments);
                };
              }
              return el;
            };

            // Capture and block click event propagation for popup/pop-under triggers
            document.addEventListener('click', function(e) {
              const tag = e.target.closest('a');
              if (tag) {
                const href = tag.getAttribute('href') || '';
                const target = tag.getAttribute('target') || '';
                if (target === '_blank' || href.includes('ad') || href.includes('pop') || href.includes('click') || href.includes('syndication') || (!href.startsWith('/') && !href.includes(window.location.hostname))) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
              }
              
              // Block invisible ads overlay click catchers
              const rect = e.target.getBoundingClientRect();
              const style = window.getComputedStyle(e.target);
              if (style.position === 'absolute' || style.position === 'fixed') {
                if (rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9 && (parseFloat(style.opacity) === 0 || style.zIndex > 10)) {
                  e.preventDefault();
                  e.stopPropagation();
                  try { e.target.remove(); } catch(err) {}
                  return false;
                }
              }
            }, true);
          </script>
          <style>
            /* Hide fake play buttons, ads overlays, and click redirection overlays */
            .play-btn, .play-button, .play_button, .play_icon, .play-icon, 
            #play-btn, #play-button, .playicon, .playbutton, .play-wrapper, 
            .play-overlay, .fake-play, .player-poster, .poster-image, 
            .click-to-play, #click-to-play, [class*="play-overlay"], 
            [class*="fake-play"], .play-button-overlay, .play-btn-overlay {
              display: none !important;
              opacity: 0 !important;
              pointer-events: none !important;
            }
          </style>
        `;

        // Strip tracking/advertising scripts
        html = html.replace(/<script[^>]*src="[^"]*(adsterra|exoclick|onclick|ad|pop|redirect|propeller|juicyads|onclickads|yandex|adnxs|doubleclick|taboola|outbrain|google-analytics|traffic|optadig360|syndication|exdynsrv|popads|popcash|admaven|propellerads)[^"]*"[^>]*><\/script>/gi, '');
        html = html.replace(/<script[^>]*>([\s\S]*?(adsterra|exoclick|onclick|popunder|redirect|propeller|juicyads|onclickads|adnxs|optadig360|syndication|popads|popcash|admaven|propellerads)[\s\S]*?)<\/script>/gi, '');

        // Inject popup blocker at start of head
        html = html.replace(/<head>/i, '<head>' + adBlockScript);

        // Rewrite relative URLs to absolute URLs
        html = html.replace(/(href|src|action)\s*=\s*["']\/([^"']+)["']/gi, (match, attr, path) => {
          if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
            return match;
          }
          return attr + '="' + originBase + '/' + path + '"';
        });

        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      }
      return;
    }

    // ── Static File Serving ───────────────────────────────────────────────
    let filePath = path.join(PUBLIC_DIR, pathname);

    // Directory traversal protection
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      logger.request(req, 403, Date.now() - startMs);
      return;
    }

    if (pathname === '/' || !path.extname(pathname)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    // ── SEO: Server-side meta injection for ToonStream anime watch pages ──────
    // When Googlebot visits /watch/tv/toon_solo-leveling, we inject the correct
    // <title>, <meta> and JSON-LD so Google indexes "Solo Leveling Hindi Dubbed"
    // without needing JavaScript. Normal users still get the full SPA experience.
    const toonWatchMatch = pathname.match(/^\/watch\/tv\/(toon_[^/?]+)/);
    if (toonWatchMatch) {
      const toonId = toonWatchMatch[1]; // e.g. "toon_solo-leveling"
      const slug = toonId.replace(/^toon_/, ''); // e.g. "solo-leveling"
      try {
        const htmlRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        let animeTitle = slug
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        let animeDesc = '';
        let animePoster = '';

        // Try to fetch real title from ToonStream (fast, cached by node process)
        try {
          const liveSvcLocal = require('./services/toonstreamLive');
          const details = await liveSvcLocal.getLiveAnimeDetails(toonId, slug);
          if (details && details.title) {
            animeTitle = details.title;
            animeDesc = (details.description || '').replace(/"/g, '&quot;').slice(0, 155);
            animePoster = details.poster || '';
          }
        } catch (_) { /* fallback to slug-derived title */ }

        const seoTitle = `${animeTitle} Hindi Dubbed (Watch in Hindi) — CineStream`;
        const seoDesc = animeDesc ||
          `Watch ${animeTitle} Hindi Dubbed online free on CineStream. Stream all episodes of ${animeTitle} in Hindi. ${animeTitle} in Hindi, ${animeTitle} Hindi Dubbed — free HD streaming.`;
        const seoKeywords = `${animeTitle} in hindi, ${animeTitle} hindi dubbed, watch ${animeTitle} in hindi, ${animeTitle} hindi dubbed free, ${animeTitle} online hindi, ${animeTitle.toLowerCase()} hindi, anime in hindi, CineStream`;
        const canonical = `https://cinestream.watch/watch/tv/${toonId}`;
        const posterUrl = animePoster || 'https://cinestream.watch/images/fav-icon.png';

        const jsonLd = JSON.stringify([
          {
            '@context': 'https://schema.org',
            '@type': 'TVSeries',
            'name': `${animeTitle} Hindi Dubbed`,
            'alternateName': [`${animeTitle} in Hindi`, `${animeTitle} Hindi`],
            'url': canonical,
            'image': posterUrl,
            'description': seoDesc,
            'inLanguage': ['hi', 'en'],
            'countryOfOrigin': { '@type': 'Country', 'name': 'Japan' },
            'audience': { '@type': 'Audience', 'geographicArea': { '@type': 'Country', 'name': 'India' } },
            'potentialAction': { '@type': 'WatchAction', 'target': canonical }
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            'itemListElement': [
              { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://cinestream.watch/' },
              { '@type': 'ListItem', 'position': 2, 'name': 'Anime in Hindi', 'item': 'https://cinestream.watch/' },
              { '@type': 'ListItem', 'position': 3, 'name': `${animeTitle} Hindi Dubbed`, 'item': canonical }
            ]
          }
        ]);

        // Inject into the raw HTML (replace placeholder tags)
        const injected = htmlRaw
          .replace(
            /<title id="seo-title">[^<]*<\/title>/,
            `<title id="seo-title">${seoTitle}</title>`
          )
          .replace(
            /<meta id="seo-desc"[^>]*>/,
            `<meta id="seo-desc" name="description" content="${seoDesc}">`
          )
          .replace(
            /<meta name="keywords"[^>]*>/,
            `<meta name="keywords" content="${seoKeywords}">`
          )
          .replace(
            /<link id="seo-canonical"[^>]*>/,
            `<link id="seo-canonical" rel="canonical" href="${canonical}">`
          )
          .replace(
            /<meta id="og-title"[^>]*>/,
            `<meta id="og-title" property="og:title" content="${seoTitle}">`
          )
          .replace(
            /<meta id="og-desc"[^>]*>/,
            `<meta id="og-desc" property="og:description" content="${seoDesc}">`
          )
          .replace(
            /<meta id="og-url"[^>]*>/,
            `<meta id="og-url" property="og:url" content="${canonical}">`
          )
          .replace(
            /<meta id="og-image"[^>]*>/,
            `<meta id="og-image" property="og:image" content="${posterUrl}">`
          )
          .replace(
            /<meta id="tw-title"[^>]*>/,
            `<meta id="tw-title" name="twitter:title" content="${seoTitle}">`
          )
          .replace(
            /<meta id="tw-desc"[^>]*>/,
            `<meta id="tw-desc" name="twitter:description" content="${seoDesc}">`
          )
          .replace(
            /<script id="ld-dynamic" type="application\/ld\+json"><\/script>/,
            `<script id="ld-dynamic" type="application/ld+json">${jsonLd}</script>`
          );

        const buf = Buffer.from(injected, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(buf);
        logger.request(req, 200, Date.now() - startMs);
        return;
      } catch (seoErr) {
        logger.warn('seo_inject_error', { message: seoErr.message });
        // Fall through to normal static serving if injection fails
      }
    }
    // ── End SEO injection ─────────────────────────────────────────────────────

    const ext = path.extname(filePath).toLowerCase();
    handleStatic(req, res, filePath, ext);
    // Note: status code is set inside handleStatic
    logger.request(req, 200, Date.now() - startMs);

  } catch (err) {
    logger.error('unhandled_request_error', err);
    statusCode = 500;
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
    logger.request(req, statusCode, Date.now() - startMs);
  }
};

const server = http.createServer(requestHandler);

// ── Server timeouts (prevent slow-client DoS) ─────────────────────────────────
server.requestTimeout = 30_000;   // 30s: max time to receive full request
server.headersTimeout = 35_000;  // 35s: slightly above requestTimeout
server.keepAliveTimeout = 65_000; // 65s: keep alive for CDN/proxy compatibility

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`server_shutdown`, { signal });
  server.close(() => {
    logger.info('server_closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => logger.error('uncaught_exception', err));
process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', { reason: String(reason) }));

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
  // Load catalogs into server memory (eliminates 3.7MB client downloads)
  await catalogSvc.loadCatalogs();

  // Connect to MongoDB (server starts even if DB is unavailable)
  try {
    await connectDB();
    queue.injectDb({ getCollection });
  } catch (err) {
    logger.warn('server_starting_without_db', { message: err.message });
  }

  // Auto-generate sitemap on startup if missing/stale, then every 24 hours
  sitemapSvc.scheduleAutoRegen();

  server.listen(PORT, () => {
    logger.info('server_started', {
      port: PORT,
      env: config.nodeEnv,
      db: isConnected() ? 'connected' : 'unavailable',
    });
  });
})();

// Export the handler function (not the server) for Vercel's @vercel/node runtime
module.exports = requestHandler;
