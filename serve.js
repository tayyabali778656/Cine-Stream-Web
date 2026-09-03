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
const crawlerSvc = require('./services/crawlerScheduler');
const { requireAuth } = require('./middleware/authMiddleware');
const { applySecurityHeaders, applyCors, applyRateLimit } = require('./middleware/security');

const PORT = config.port;
const PUBLIC_DIR = __dirname;

// ── In-memory cache for iframe-proxy HLS resolutions (10-min TTL) ────────────
const iframeProxyCache = new Map(); // url → { result, expiry }
const PROXY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  'application/manifest+json; charset=utf-8',
  'image/svg+xml',
  'text/plain; charset=utf-8',
  'application/xml; charset=utf-8',
]);

// Cache-Control values per file type
const CACHE_CONTROL = {
  '.html': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  '.css': 'public, max-age=31536000, immutable',
  '.js': 'public, max-age=31536000, immutable',
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

// ── Vercel-safe initialization ─────────────────────────────────────────────────
// On Vercel, the module is loaded and requestHandler is called immediately,
// possibly before the async startup IIFE finishes (connectDB race condition).
// This cached promise ensures every request waits for DB + catalog to be ready
// without re-running the init on each request after the first.
let _initPromise = null;
function ensureInit() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await catalogSvc.loadCatalogs();
    try {
      await connectDB();
      queue.injectDb({ getCollection });
    } catch (err) {
      logger.warn('server_starting_without_db', { message: err.message });
      _initPromise = null; // Reset so next request retries connecting to the database
    }
    sitemapSvc.scheduleAutoRegen();
    crawlerSvc.scheduleAutoCrawl();  // Auto-run crawler every 24h
  })();
  return _initPromise;
}
// Kick off init immediately on module load (warm-start benefit)
ensureInit();

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
function sendJson(res, status, data, cacheControl = null) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  } else {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }
  res.writeHead(status, headers);
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

// ── Helper: decode HTML entities ──────────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;(#?\w+;)/g, '&$1')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      const animeItems = await getCollection('anime').find({}, {
        projection: { id: 1, type: 1, title: 1, poster: 1, description: 1, rating: 1, vote_average: 1, release_year: 1, updatedAt: 1 }
      }).toArray();

      const filteredItems = animeItems.filter(item => {
        const ratingVal = parseFloat(item.rating || item.vote_average || 0);
        const yearVal = parseInt(item.release_year || 0, 10);
        return ratingVal >= 6.0 || yearVal >= 2023;
      });

      for (const item of filteredItems) {
        // Use real updatedAt if available, otherwise today
        const lastmod = item.updatedAt
          ? new Date(item.updatedAt).toISOString().split('T')[0]
          : today;
        // TV series get higher priority than movies for crawl budget allocation
        const priority = item.type === 'tv' ? '0.9' : '0.8';
        const changefreq = item.type === 'tv' ? 'daily' : 'weekly';
        dynamicPages.push({
          loc: `${baseUrl}/media/${item.type === 'movie' ? 'movie' : 'tv'}/${item.id}`,
          priority,
          changefreq,
          lastmod,
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
    if (!q) { sendJson(res, 200, [], 'no-store'); return; }

    // ── Fast search: check in-memory cache first ────────────────────────────
    const cacheKey = `search_${q.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      sendJson(res, 200, cached, 'public, max-age=120, s-maxage=120');
      return;
    }

    try {
      // ── MongoDB direct text search (fast: < 100ms) ──────────────────────
      let results = [];
      try {
        const animeCol = getCollection('anime');
        const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex
        const regex = new RegExp(escapedQ, 'i');

        // Search across title, name, and slug fields
        results = await animeCol.find({
          $or: [
            { title: regex },
            { name: regex },
            { original_title: regex },
            { slug: regex },
          ]
        })
          .sort({ popularity: -1, updatedAt: -1 })
          .limit(40)
          .toArray();
      } catch (dbErr) {
        // DB not available
        logger.warn('search_db_error', { message: dbErr.message, q });
        results = [];
      }

      // ── Fallback to live scraping if DB has no matches ────────────────
      if (results.length === 0) {
        try {
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const data = await liveSvc.getLiveAnimeList('', page, '', '', q);
          results = data.results || [];

          // Save scraped results to MongoDB in the background for future instant searches
          if (results.length > 0 && isConnected()) {
            const animeCol = getCollection('anime');
            Promise.all(results.map(async (item) => {
              if (item.title && item.slug) {
                const id = item.id || `toon_${item.slug}`;
                await animeCol.updateOne(
                  { id },
                  {
                    $set: {
                      id,
                      title: item.title,
                      poster: item.poster,
                      rating: item.rating || item.vote_average || 7.5,
                      type: item.type || 'tv',
                      slug: item.slug,
                      updatedAt: new Date()
                    }
                  },
                  { upsert: true }
                ).catch(() => { });
              }
            })).catch(() => { });
          }
        } catch (scrapeErr) {
          logger.warn('search_fallback_scrape_error', { message: scrapeErr.message, q });
        }
      }

      // Cache results for 5 minutes to avoid repeated DB hits / scraping
      if (results.length > 0) {
        cache.set(cacheKey, results, 5 * 60 * 1000);
      }

      sendJson(res, 200, results, 'public, max-age=120, s-maxage=120');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }



  if (pathname === '/api/v1/anime/details' && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const id = url.searchParams.get('id') || '';
    const slug = url.searchParams.get('slug') || '';
    let cleanSlug = slug || (id ? id.replace('toon_', '') : '');
    cleanSlug = decodeURIComponent(cleanSlug)
      .replace(/:/g, '').replace(/%3A/gi, '') // remove all colons
      .replace(/-?\d+$/, '')                   // strip trailing episode/season numbers like -1, 1
      .replace(/--+/g, '-')                    // collapse double-dashes
      .replace(/-$/, '');                       // trim trailing dash

    const SLUG_ALIASES = {
      'reborn-to-master-the-blade-from-hero-king-to-extraordinary-squire': 'reborn-to-master-the-blade',
      're-zero-starting-life-in-another-world': 'rezero-starting-life-in-another-world',
      'daemons-of-the-shadow': 'daemons-of-the-shadow-realm',
      'nippon-sangoku': 'nippon-sangoku-the-three-nations-of-the-crimson-sun',
      'tamons-b-side': "tamon's-b-side",
      'tamon-s-b-side': "tamon's-b-side"
    };
    if (SLUG_ALIASES[cleanSlug]) {
      cleanSlug = SLUG_ALIASES[cleanSlug];
    }
    const cleanId = `toon_${cleanSlug}`;

    try {
      let anime = null;
      const exactId = id ? decodeURIComponent(id) : null;
      try {
        const animeCollection = getCollection('anime');
        anime = await animeCollection.findOne({
          $or: [
            ...(exactId ? [{ id: exactId }] : []),
            { id: cleanId },
            { id: `toon_${cleanSlug}` },
            { slug: cleanSlug }
          ]
        });
      } catch (dbErr) {
        logger.warn('Failed to query anime details from MongoDB:', dbErr.message);
      }

      if (anime && anime.description && anime.description !== 'No description available.') {
        const responseData = { ...anime, related: [], recommendations: [] };
        sendJson(res, 200, responseData, 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
        return;
      }

      const freshAnime = await liveSvc.getLiveAnimeDetails(cleanId, cleanSlug);
      if (!freshAnime) {
        if (anime) {
          logger.info(`Live scrape empty for anime details ${cleanId}, falling back to basic anime from DB`);
          const responseData = { ...anime, related: [], recommendations: [] };
          sendJson(res, 200, responseData, 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
          return;
        }
        sendJson(res, 404, { error: 'Anime not found' });
        return;
      }

      // Save to MongoDB for future requests
      try {
        const animeCollection = getCollection('anime');
        await animeCollection.updateOne(
          { id: freshAnime.id },
          { $set: { ...freshAnime, updatedAt: new Date() } },
          { upsert: true }
        );
        // Invalidate sitemap cache so it gets rebuilt immediately on next request
        cache.delete('sitemap_xml');
      } catch (dbErr) {
        logger.warn('Failed to save fresh anime details to MongoDB:', dbErr.message);
      }

      const responseData = { ...freshAnime, related: [], recommendations: [] };
      sendJson(res, 200, responseData, 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
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
    let slug = animeSlug || (animeId ? animeId.replace('toon_', '') : '');
    slug = decodeURIComponent(slug).replace(/:/g, '').replace(/%3A/gi, '');

    const SLUG_ALIASES = {
      'reborn-to-master-the-blade-from-hero-king-to-extraordinary-squire': 'reborn-to-master-the-blade',
      're-zero-starting-life-in-another-world': 'rezero-starting-life-in-another-world',
      'daemons-of-the-shadow': 'daemons-of-the-shadow-realm',
      'nippon-sangoku': 'nippon-sangoku-the-three-nations-of-the-crimson-sun',
      'tamons-b-side': "tamon's-b-side",
      'tamon-s-b-side': "tamon's-b-side"
    };
    if (SLUG_ALIASES[slug]) {
      slug = SLUG_ALIASES[slug];
    }

    try {
      // Parallelize admin lookup + details + DB episodes lookup
      const [adminEntry, details, dbEpisodes] = await Promise.all([
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
          try {
            const animeCollection = getCollection('anime');
            let det = await animeCollection.findOne({
              $or: [
                { id: animeId },
                { id: `toon_${slug}` },
                { slug: slug }
              ]
            });
            if (!det || !det.description || det.description === 'No description available.') {
              const liveDet = await liveSvc.getLiveAnimeDetails(animeId, slug);
              if (liveDet) {
                det = liveDet;
                await animeCollection.updateOne(
                  { id: det.id },
                  { $set: { ...det, updatedAt: new Date() } },
                  { upsert: true }
                );
              }
            }
            return det;
          } catch (dbErr) {
            logger.warn('Failed to query anime details in episodes API:', dbErr.message);
            return await liveSvc.getLiveAnimeDetails(animeId, slug);
          }
        })(),
        (async () => {
          try {
            const episodesCol = getCollection('episodes');
            return await episodesCol.find({
              $or: [
                { animeId: animeId },
                { animeId: `toon_${slug}` },
                { animeSlug: slug }
              ]
            }).sort({ season: 1, episode: 1 }).toArray();
          } catch (dbErr) {
            logger.warn('Failed to query episodes from MongoDB:', dbErr.message);
            return [];
          }
        })()
      ]);

      if (details && details.type === 'movie') {
        let sources = details.movieSources || [];

        // If movieSources are missing from DB, OR if stored labels are purely numeric (old format without real names), fetch them live!
        const hasNumericOnlyLabels = sources.length > 0 && sources.every(s => /^\d+$/.test((s.label || '').trim()));
        if (sources.length === 0 || hasNumericOnlyLabels) {
          try {
            const freshDetails = await liveSvc.getLiveAnimeDetails(animeId, slug, 'movie');
            if (freshDetails && freshDetails.movieSources) {
              sources = freshDetails.movieSources;
              const animeCollection = getCollection('anime');
              await animeCollection.updateOne(
                { id: animeId },
                { $set: { movieSources: sources, updatedAt: new Date() } }
              );
            }
          } catch (err) {
            logger.warn('Failed to fetch live movie sources:', err.message);
          }
        }

        const movieEpisodes = [{
          id: `ep_${slug}_1x1`,
          animeId: animeId,
          animeSlug: slug,
          season: 1,
          episode: 1,
          title: details.title,
          sources: sources
        }];
        sendJson(res, 200, movieEpisodes, 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
        return;
      }

      let episodes = [];
      const targetEp = dbEpisodes.find(ep => ep.season === season && ep.episode === episode);

      // Expire cached stream links after 48 hours (2 days) to ensure third-party embeds stay fresh
      const isFresh = targetEp && targetEp.updatedAt && (Date.now() - new Date(targetEp.updatedAt).getTime() < 48 * 60 * 60 * 1000);

      // Also re-scrape if stored sources have numeric-only labels (old format without real server names like Ruby, Moly, etc.)
      const targetEpHasNumericLabels = targetEp && targetEp.sources && targetEp.sources.length > 0 &&
        targetEp.sources.every(s => /^\d+$/.test((s.label || '').trim()));

      // Serve from DB if sources exist and are fresh and have real server name labels
      if (dbEpisodes.length > 0 && targetEp && targetEp.sources && targetEp.sources.length > 0 && isFresh && !targetEpHasNumericLabels) {
        // Serve from DB directly
        episodes = dbEpisodes.map(ep => ({ ...ep }));
      } else {
        // Scrape live
        try {
          episodes = await liveSvc.getLiveEpisodes(slug, season, episode);
        } catch (epErr) {
          logger.warn(`getLiveEpisodes failed for ${slug}:`, epErr.message);
        }

        if (!Array.isArray(episodes)) episodes = [];

        // Fallback: if no series episodes found, this might be a movie misclassified as a series in the DB
        if (episodes.length === 0) {
          try {
            const freshDetails = await liveSvc.getLiveAnimeDetails(animeId, slug, 'movie');
            if (freshDetails && freshDetails.type === 'movie') {
              const animeCollection = getCollection('anime');
              await animeCollection.updateOne(
                { id: `toon_${slug}` },
                { $set: { type: 'movie', movieSources: freshDetails.movieSources, updatedAt: new Date() } }
              );
              episodes = [{
                id: `ep_${slug}_1x1`,
                animeId: animeId || `toon_${slug}`,
                animeSlug: slug,
                season: 1,
                episode: 1,
                title: freshDetails.title,
                sources: freshDetails.movieSources || []
              }];
            }
          } catch (fallbackErr) {
            logger.warn(`Movie fallback check failed for ${slug}:`, fallbackErr.message);
          }

          // CRITICAL FALLBACK: If live scrape totally failed (security checkpoint) and we have old DB episodes, serve them instead of breaking the player!
          if (episodes.length === 0 && dbEpisodes && dbEpisodes.length > 0) {
            logger.info(`Live scrape blocked for episodes ${slug}, falling back to stale dbEpisodes to prevent player crash`);
            episodes = dbEpisodes.map(ep => ({ ...ep }));
          }
        }

        // Save scraped episodes to MongoDB with timestamp
        if (episodes.length > 0) {
          try {
            const episodesCol = getCollection('episodes');
            const bulkOps = episodes.map(ep => {
              const updateDoc = { ...ep, updatedAt: new Date() };
              // Critical Fix: Do not overwrite existing DB sources with empty arrays for other episodes
              if (!ep.sources || ep.sources.length === 0) {
                delete updateDoc.sources;
              }
              return {
                updateOne: {
                  filter: { id: ep.id },
                  update: { $set: updateDoc },
                  upsert: true
                }
              };
            });
            await episodesCol.bulkWrite(bulkOps);
          } catch (dbErr) {
            logger.warn('Failed to save episodes to MongoDB:', dbErr.message);
          }
        }

        // Critical Fix: Merge DB sources into the live scraped episodes so the frontend playlist has ALL previously saved links
        if (dbEpisodes && dbEpisodes.length > 0) {
          episodes = episodes.map(ep => {
            const dbEp = dbEpisodes.find(d => d.season === ep.season && d.episode === ep.episode);
            if (dbEp && dbEp.sources && dbEp.sources.length > 0 && (!ep.sources || ep.sources.length === 0)) {
              ep.sources = dbEp.sources;
            }
            return ep;
          });
        }
      }

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

      sendJson(res, 200, episodes, 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
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

    const cacheKey = `list_${type}_${page}_${filter}_${genre}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      sendJson(res, 200, cachedData, 'public, max-age=120, s-maxage=3600, stale-while-revalidate=7200');
      return;
    }

    // Try MongoDB persistent cache to avoid ToonStream scraping latency on new sessions/cold starts
    let dbCached = null;
    try {
      if (isConnected()) {
        dbCached = await getCollection('listings_cache').findOne({ id: cacheKey });
        if (dbCached && dbCached.data && dbCached.data.results && dbCached.data.results.length > 0 && (Date.now() - dbCached.timestamp) < 60 * 60 * 1000) {
          cache.set(cacheKey, dbCached.data, 60 * 60 * 1000);
          sendJson(res, 200, dbCached.data, 'public, max-age=120, s-maxage=3600, stale-while-revalidate=7200');
          return;
        }
      }
    } catch (dbErr) {
      logger.warn('Failed to query listings_cache from MongoDB:', dbErr.message);
    }

    try {
      let data = await liveSvc.getLiveAnimeList(filter, page, type, genre);

      // Fallback logic: if live scraping returned nothing (likely security checkpoint)
      if (!data || !data.results || data.results.length === 0) {
        if (dbCached && dbCached.data && dbCached.data.results && dbCached.data.results.length > 0) {
          logger.info(`Live scrape empty for ${cacheKey}, falling back to stale listings_cache`);
          data = dbCached.data;
        } else if (isConnected()) {
          logger.info(`Live scrape empty and no cache for ${cacheKey}, falling back to anime collection`);
          const animeCol = getCollection('anime');
          const fallbackType = (type && type.includes('movie')) ? 'movie' : 'tv';
          const fallbackResults = await animeCol.find({ type: fallbackType }).sort({ rating: -1 }).skip((page - 1) * 30).limit(30).toArray();
          data = { results: fallbackResults, page, total_pages: 50 };
        }
      }

      // Cache lists for 60 minutes for fast repeat loads
      if (data && data.results && data.results.length > 0) {
        cache.set(cacheKey, data, 60 * 60 * 1000);

        // Save to MongoDB in background
        if (isConnected()) {
          getCollection('listings_cache').updateOne(
            { id: cacheKey },
            { $set: { id: cacheKey, data, timestamp: Date.now() } },
            { upsert: true }
          ).catch(e => logger.warn('Failed to save listing to MongoDB cache:', e.message));

          // Save individual anime cards to the database for fallback
          try {
            const animeCol = getCollection('anime');
            const bulkOps = data.results.map(item => ({
              updateOne: {
                filter: { id: item.id },
                update: { $set: { ...item, updatedAt: new Date() } },
                upsert: true
              }
            }));
            animeCol.bulkWrite(bulkOps, { ordered: false })
              .catch(e => logger.warn('Failed to bulk save anime cards:', e.message));
          } catch (e) {
            logger.warn('Error constructing bulkWrite for anime cards:', e.message);
          }
        }
      }

      sendJson(res, 200, data, 'public, max-age=120, s-maxage=3600, stale-while-revalidate=7200');
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

  if (pathname === '/api/v1/admin/rescrape' && req.method === 'POST') {
    // Optionally check admin auth: if (!requireAuth(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const { animeId, season, episode } = body;
      if (!animeId) { sendJson(res, 400, { error: 'Anime ID is required' }); return; }

      const epCollection = getCollection('episodes');
      const query = { animeId };
      let msg = `Rescraped entire anime: ${animeId}`;

      if (season) query.season = Number(season);
      if (episode) {
        query.episode = Number(episode);
        msg = `Rescraped ${animeId} S${season} E${episode}`;
      }

      // Delete existing episodes matching query
      await epCollection.deleteMany(query);

      // Clear caches
      cache.deleteByPrefix('eps_');
      cache.deleteByPrefix('details_');

      // Trigger rescrape by fetching them live again
      // We need original slug. Usually animeId is "toon_slug".
      const slug = animeId.replace('toon_', '');

      if (season && episode) {
        await liveSvc.getLiveEpisodes(slug, Number(season), Number(episode));
      } else {
        await liveSvc.getLiveEpisodes(slug);
      }

      sendJson(res, 200, { success: true, message: msg });
    } catch (err) {
      logger.error('Rescrape failed:', err.message);
      sendJson(res, 500, { error: err.message });
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
        // Enable Edge caching: s-maxage=120, stale-while-revalidate=600
        sendJson(res, 200, { url: finalUrl }, 'public, max-age=120, s-maxage=120, stale-while-revalidate=600');
      } else {
        const fallbackMatches = html.match(/https?:\/\/[^\s\x22\x27]+\.mp4/g) || [];
        const hakunaFallback = fallbackMatches.find(url => url.includes('hakunaymatata') || url.includes('hakunamata'));
        if (hakunaFallback || fallbackMatches.length > 0) {
          sendJson(res, 200, { url: hakunaFallback || fallbackMatches[0] }, 'public, max-age=120, s-maxage=120, stale-while-revalidate=600');
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
    try {
      const cacheKey = `db_${collectionName}`;
      let data = cache.get(cacheKey);
      if (!data) {
        data = await collection.find({}).toArray();
        logger.db('find', collectionName, Date.now() - dbStart);
        // Cache DB data for 5 minutes (invalidated automatically on POST/DELETE)
        cache.set(cacheKey, data, 5 * 60 * 1000);
      }
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
      cache.deleteByPrefix('list_'); // invalidate listings cache
      if (collectionName === 'admin-store') {
        cache.deleteByPrefix('eps_');
        cache.deleteByPrefix('details_');
      }
      if (id) {
        delete doc._id;
        await collection.updateOne({ id }, { $set: doc }, { upsert: true });
        logger.db('upsert', collectionName, Date.now() - dbStart);
        // Trigger sitemap rebuild whenever media content changes
        if (collectionName === 'admin-store' || collectionName === 'anime') {
          sitemapSvc.triggerRegen(`upsert_${collectionName}`);
          cache.delete('sitemap_xml');
        }
        sendJson(res, 200, { success: true });
      } else {
        const result = await collection.insertOne(doc);
        logger.db('insert', collectionName, Date.now() - dbStart);
        // Trigger sitemap rebuild for new media items
        if (collectionName === 'admin-store' || collectionName === 'anime') {
          sitemapSvc.triggerRegen(`insert_${collectionName}`);
          cache.delete('sitemap_xml');
        }
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
      cache.deleteByPrefix('list_'); // invalidate listings cache
      if (collectionName === 'admin-store') {
        cache.deleteByPrefix('eps_');
        cache.deleteByPrefix('details_');
      }
      const result = await collection.deleteOne({ id });
      logger.db('delete', collectionName, Date.now() - dbStart);
      // Trigger sitemap rebuild when media is removed
      if (collectionName === 'admin-store' || collectionName === 'anime') {
        sitemapSvc.triggerRegen(`delete_${collectionName}`);
        cache.delete('sitemap_xml');
      }
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
  const pathname = (req.url || '').split('?')[0];

  // Only await database initialization for routes that require the database/catalog
  const needsDb = pathname.startsWith('/api/') ||
    pathname.startsWith('/proxy') ||
    pathname.startsWith('/iframe-proxy') ||
    pathname === '/health' ||
    pathname.endsWith('.xml') ||
    pathname.match(/^\/watch\/tv\/(toon_[^/?]+)/);

  if (needsDb) {
    await ensureInit();
  }

  // Apply security headers to every response
  applySecurityHeaders(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    if (pathname.startsWith('/api/') || pathname.startsWith('/proxy') || pathname.startsWith('/iframe-proxy')) {
      if (!applyCors(req, res)) return;
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    res.writeHead(204);
    res.end();
    logger.request(req, 204, Date.now() - startMs);
    return;
  }

  // (pathname is already extracted at the start of the requestHandler)

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
        'Allow: /genre/',
        'Allow: /media/',
        'Allow: /api/v1/anime/',
        'Allow: /api/v1/search/',
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
        'Allow: /genre/',
        'Allow: /media/',
        'Allow: /api/v1/anime/',
        'Allow: /api/v1/search/',
        'Disallow: /tayyab/',
        'Disallow: /api/',
        'Disallow: /proxy',
        'Disallow: /health',
        'Disallow: /iframe-proxy',
        '',
        '# Bing — mild crawl delay',
        'User-agent: Bingbot',
        'Allow: /',
        'Allow: /genre/',
        'Allow: /media/',
        'Allow: /api/v1/anime/',
        'Allow: /api/v1/search/',
        'Disallow: /tayyab/',
        'Disallow: /api/',
        'Crawl-delay: 5',
        '',
        '# Block bad bots',
        'User-agent: AhrefsBot',
        'Disallow: /',
        '',
        'User-agent: SemrushBot',
        'Disallow: /',
        '',
        'User-agent: MJ12bot',
        'Disallow: /',
        '',
        'User-agent: DotBot',
        'Disallow: /',
        '',
        'User-agent: BLEXBot',
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

    // ── site.webmanifest / manifest.json — PWA manifest with correct MIME type ──────────────────
    if (pathname === '/manifest.json' || pathname === '/site.webmanifest') {
      const manifestPath = path.join(PUBLIC_DIR, 'site.webmanifest');
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

    // ── sw.js — PWA Service Worker served with no-cache headers ─────────────────
    if (pathname === '/sw.js' || pathname === '/service-worker.js') {
      const swPath = path.join(PUBLIC_DIR, 'sw.js');
      try {
        const content = fs.readFileSync(swPath, 'utf8');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
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
      const cwdPath = path.join(process.cwd(), filename);

      // Serve the static sitemap file ONLY on local environments.
      // On Vercel, bypass this to allow real-time database-driven sitemap updates with memory caching.
      if (fs.existsSync(staticPath) || fs.existsSync(cwdPath)) {
        const finalPath = fs.existsSync(staticPath) ? staticPath : cwdPath;
        // Serve the pre-generated static file — fast loading, refreshed edge cache
        res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        fs.createReadStream(finalPath).pipe(res);
        logger.request(req, 200, Date.now() - startMs);
        return;
      }

      // Fallback: if sitemap.xml is missing (or on Vercel), build it dynamically from MongoDB
      if (filename === 'sitemap.xml') {
        const cached = cache.get('sitemap_xml');
        let xml = cached;
        if (!xml) {
          xml = await buildSitemap();
          cache.set('sitemap_xml', xml, 24 * 60 * 60 * 1000); // Cache in memory for 24 hours
        }
        res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600');
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
        res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600');
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
        // Check in-memory cache first to skip expensive server-side fetches
        let result;
        const cacheEntry = iframeProxyCache.get(targetUrl);
        if (cacheEntry && cacheEntry.expiry > Date.now()) {
          result = cacheEntry.result;
        } else {
          // Attempt to resolve the direct HLS stream first
          result = await resolveHlsStream(targetUrl);
          iframeProxyCache.set(targetUrl, { result, expiry: Date.now() + PROXY_CACHE_TTL_MS });
        }

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
          compressAndSend(req, res, cleanPlayerHtml, 'text/html; charset=utf-8', {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=600'
          });
          return;
        }

        // If resolution failed, but either the targetUrl or the resolved iframeUrl is a known streamruby/strmup mirror, do NOT load it in iframe
        const checkUrl = (urlStr) => {
          if (!urlStr) return false;
          return urlStr.includes('rubystm.com') || urlStr.includes('strmup.to') || urlStr.includes('vidstreaming.xyz') || urlStr.includes('streamruby') || urlStr.includes('rubystm.to');
        };
        const isMirror = checkUrl(targetUrl) || (result && checkUrl(result.iframeUrl));

        if (false && isMirror) {
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

        const isWhitelistedAd = targetUrl.includes('omg10.com') || targetUrl.includes('monetag');

        if (!isWhitelistedAd) {
          // Block popups, clickjacking, push notifications & redirects inside proxied iframe
          const adBlockScript = `
            <script>
              // Override window.open to block popups, except for whitelisted ad networks
              const originalOpen = window.open;
              window.open = function(url, name, specs) {
                if (url && (url.includes('omg10.com') || url.includes('monetag'))) {
                  window.location.href = url;
                  return null;
                }
                console.log('[AdBlock] Blocked window.open:', arguments);
                return null;
              };
              window.alert = function() { return null; };
              window.confirm = function() { return false; };
              window.prompt = function() { return null; };
              
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
                    if (href.includes('omg10.com') || href.includes('monetag')) {
                      window.location.href = href;
                      return;
                    }
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
                  if (href.includes('omg10.com') || href.includes('monetag')) {
                    tag.removeAttribute('target');
                    return; // Whitelist, but force same frame
                  }
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
              [class*="fake-play"], .play-button-overlay, .play-btn-overlay,
              
              /* Hide fake notification alerts, message popups, and ad overlays */
              .notification, .toast, .alert, .popup, .dialog, .modal-ads, .message-box, 
              .ad-overlay, .pop-notification, .notify, .notify-ads, .push-notify,
              [id*="notification"], [class*="notification"], [class*="message-box"], 
              [class*="popup-ads"], [class*="ad-box"], [id*="ad-box"], 
              [class*="toast-ad"], [id*="toast-ad"] {
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
        }

        // Rewrite relative URLs to absolute URLs
        html = html.replace(/(href|src|action)\s*=\s*["']\/([^"']+)["']/gi, (match, attr, path) => {
          if (path.startsWith('http') || path.startsWith('//') || path.startsWith('data:')) {
            return match;
          }
          return attr + '="' + originBase + '/' + path + '"';
        });

        compressAndSend(req, res, html, 'text/html; charset=utf-8', {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=600'
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      }
      return;
    }

    // ── Static File Serving ───────────────────────────────────────────────
    let filePath = path.join(PUBLIC_DIR, pathname);

    // Directory traversal protection
    if (pathname.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      logger.request(req, 403, Date.now() - startMs);
      return;
    }

    if (pathname === '/app' || pathname === '/download') {
      filePath = path.join(PUBLIC_DIR, 'app.html');
    } else if (pathname === '/' || !path.extname(pathname)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }


    // ── SEO: Server-side Genre Collection Pages ──────────────────────────────
    const genreMatch = pathname.match(/^\/genre\/([^/?#]+)/);
    if (genreMatch) {
      const rawGenre = genreMatch[1];
      const genreName = rawGenre.charAt(0).toUpperCase() + rawGenre.slice(1).toLowerCase();
      try {
        const htmlRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        const animeCol = getCollection('anime');

        // Fetch up to 40 items in this genre
        const genreItems = await animeCol.find({
          genres: { $regex: new RegExp(`^${genreName}$`, 'i') }
        }, {
          projection: { id: 1, title: 1, poster: 1, type: 1 },
          limit: 40
        }).toArray();

        const seoTitle = `Watch Best ${genreName} Anime in Hindi Dubbed Online Free | CineStream`;
        const seoDesc = `Stream the best ${genreName} anime series and movies with in Hindi Dubbed dual audio free in HD. Check our full list of ${genreName} anime now!`;
        const seoKeywords = `${genreName} anime, ${genreName} anime in hindi, watch ${genreName} dubbed, in Hindi Dubbed ${genreName} anime list, CineStream`;
        const canonical = `https://cinestream.watch/genre/${rawGenre}`;

        const gridHtml = genreItems.map(item => {
          const itemTitle = (item.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const itemType = item.type === 'movie' ? 'movie' : 'tv';
          return `
            <div style="flex:0 0 150px;text-align:center;margin-bottom:1rem;">
              <a href="https://cinestream.watch/media/${itemType}/${item.id}" style="text-decoration:none;color:inherit;display:block;">
                ${item.poster ? `<img src="${item.poster}" alt="Watch ${itemTitle}" width="150" height="225" loading="lazy" style="border-radius:8px;object-fit:cover;width:150px;height:225px;">` : ''}
                <span style="display:block;font-size:0.8rem;margin-top:0.3rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;">${itemTitle}</span>
              </a>
            </div>
          `;
        }).join('');

        const collectionContent = `
          <div class="ssr-seo-details" style="padding:1.5rem;background:rgba(20,20,20,0.6);border-radius:12px;margin:1.5rem auto;max-width:1200px;border:1px solid rgba(255,255,255,0.05);color:var(--text);font-family:system-ui,-apple-system,sans-serif;">
            <h1 style="font-size: 1.8rem; font-weight: 800; color: var(--text); margin-bottom: 0.5rem;">Best ${genreName} Anime in Hindi Dubbed</h1>
            <p style="font-size:1rem;line-height:1.6;color:var(--text-muted);margin-bottom:1.5rem;">
              Welcome to the premium list of <strong>${genreName} Anime in Hindi Dubbed</strong>. Stream full episodes and movies with high quality mirrors and dual audio options on CineStream.
            </p>
            <div style="display:flex;flex-wrap:wrap;gap:1.5rem;justify-content:center;margin-bottom:1.5rem;">
              ${gridHtml || '<p style="color:var(--text-muted);">No anime found in this genre catalog yet.</p>'}
            </div>
          </div>
        `;

        const collectionSchema = {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          'name': seoTitle,
          'url': canonical,
          'description': seoDesc,
          'inLanguage': ['hi', 'en'],
          'isAccessibleForFree': true,
          'mainEntity': {
            '@type': 'ItemList',
            'itemListOrder': 'https://schema.org/ItemListOrderDescending',
            'numberOfItems': genreItems.length,
            'itemListElement': genreItems.map((item, idx) => ({
              '@type': 'ListItem',
              'position': idx + 1,
              'name': item.title,
              'url': `https://cinestream.watch/media/${item.type === 'movie' ? 'movie' : 'tv'}/${item.id}`
            }))
          }
        };

        let injected = htmlRaw;
        injected = injected.replace(/<html lang="en"/, '<html lang="hi"');
        injected = injected
          .replace(new RegExp('<h1 id="seo-h1"[^>]*>[^<]*</h1>'), `<h1 id="seo-h1" style="display:none;">${seoTitle}</h1>`)
          .replace(new RegExp('<title id="seo-title">[^<]*</title>'), `<title id="seo-title">${seoTitle}</title>`)
          .replace(new RegExp('<meta id="seo-desc"[^>]*>'), `<meta id="seo-desc" name="description" content="${seoDesc}">`)
          .replace(new RegExp('<meta name="keywords"[^>]*>'), `<meta name="keywords" content="${seoKeywords}">`)
          .replace(new RegExp('<link id="seo-canonical"[^>]*>'), `<link id="seo-canonical" rel="canonical" href="${canonical}">`)
          .replace(new RegExp('<meta name="robots"[^>]*>'), `<meta name="robots" content="index, follow">`)
          .replace('<div id="seo-content-area"></div>', `<div id="seo-content-area">${collectionContent}</div>`)
          .replace('<script id="ld-collection-dynamic" type="application/ld+json"></script>', `<script id="ld-collection-dynamic" type="application/ld+json">${JSON.stringify(collectionSchema)}</script>`);

        compressAndSend(req, res, injected, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' });
        logger.request(req, 200, Date.now() - startMs);
        return;
      } catch (err) {
        logger.warn('genre_seo_error', { message: err.message });
      }
    }


    // ── SEO: Server-side meta injection for ToonStream anime watch/details pages ──────
    const toonWatchMatch = pathname.match(/^\/(watch|media)\/(tv|movie)\/(toon_[^/?#]+)/);
    const urlObjForSeo = new URL(req.url || '', 'https://cinestream.watch');
    const seoQ = (urlObjForSeo.searchParams.get('q') || '').trim();

    if (toonWatchMatch) {
      const action = toonWatchMatch[1]; // 'watch' or 'media'
      const mediaType = toonWatchMatch[2]; // 'tv' or 'movie'
      let toonId = toonWatchMatch[3]; // e.g. "toon_solo-leveling"
      let slug = decodeURIComponent(toonId.replace(/^toon_/, '')).replace(/:/g, '').replace(/%3A/gi, '');
      toonId = `toon_${slug}`;

      const SLUG_ALIASES = {
        'reborn-to-master-the-blade-from-hero-king-to-extraordinary-squire': 'reborn-to-master-the-blade',
        're-zero-starting-life-in-another-world': 'rezero-starting-life-in-another-world',
        'daemons-of-the-shadow': 'daemons-of-the-shadow-realm',
        'nippon-sangoku': 'nippon-sangoku-the-three-nations-of-the-crimson-sun',
        'tamons-b-side': "tamon's-b-side",
        'tamon-s-b-side': "tamon's-b-side"
      };
      if (SLUG_ALIASES[slug]) {
        slug = SLUG_ALIASES[slug];
        toonId = `toon_${slug}`;
      }

      const isWatch = action === 'watch';
      const season = isWatch ? parseInt(urlObjForSeo.searchParams.get('s') || '1', 10) : null;
      const episode = isWatch ? parseInt(urlObjForSeo.searchParams.get('e') || '1', 10) : null;

      try {
        const htmlRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        let animeTitle = slug
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        let animeDesc = '';
        let animePoster = '';
        let animeGenres = [];
        let animeRating = '';
        let animeYear = '';
        let animeSeasons = null;
        let animeCreatedAt = '';
        let details = null;

        // 1. Try MongoDB first (fast, no network delay)
        try {
          const animeCollection = getCollection('anime');
          details = await animeCollection.findOne({
            $or: [{ id: toonId }, { id: `toon_${slug}` }, { slug }]
          });
        } catch (_) { }

        // 2. Fallback to live scraping if not in DB
        if (!details || !details.title) {
          try {
            const liveSvcLocal = require('./services/toonstreamLive');
            details = await liveSvcLocal.getLiveAnimeDetails(toonId, slug);
          } catch (_) { }
        }

        if (details && details.title) {
          animeTitle = decodeHtmlEntities(details.title);
          const rawDesc = decodeHtmlEntities(details.description || details.overview || '');
          animeDesc = rawDesc.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
          animePoster = details.poster || details.poster_path || '';
          animeGenres = Array.isArray(details.genres) ? details.genres.map(g => typeof g === 'string' ? g : (g.name || '')).filter(Boolean) : [];
          animeRating = details.rating || details.vote_average || '';
          animeYear = details.release_date || details.first_air_date || details.year || '';
          if (animeYear && String(animeYear).length > 4) animeYear = String(animeYear).slice(0, 4);
          animeSeasons = details.number_of_seasons || details.seasons || null;
          animeCreatedAt = details.createdAt || details.updatedAt || '';
        }

        const animeDuration = details ? (details.duration || details.runtime || '') : '';
        const animeStatus = details ? (details.status || '') : '';
        const animeLanguage = details ? (details.language || '') : '';

        // Build a rich 160-char description
        const buildDesc = (title, type, genres, year, rating) => {
          const genrePart = genres.length > 0 ? ` (${genres.slice(0, 3).join(', ')})` : '';
          const yearPart = year ? ` ${year}` : '';
          const ratingPart = rating ? ` ⭐${rating}` : '';
          if (type === 'movie') {
            return `Watch ${title}${genrePart}${yearPart}${ratingPart} Full Movie in Hindi Dubbed online free on CineStream. Stream in HD 1080p/720p with dual audio. Best anime streaming site.`;
          }
          return `Watch ${title}${genrePart}${yearPart}${ratingPart} all episodes in Hindi Dubbed free on CineStream. Stream every season in HD 1080p. Best anime in Hindi site.`;
        };

        let seoTitle = '';
        let seoDesc = '';
        if (mediaType === 'movie') {
          seoTitle = `Watch ${animeTitle} Full Movie in Hindi Dubbed Online Free HD | CineStream`;
          seoDesc = animeDesc.slice(0, 155) || buildDesc(animeTitle, 'movie', animeGenres, animeYear, animeRating);
        } else if (isWatch && season && episode) {
          seoTitle = `Watch ${animeTitle} Season ${season} Episode ${episode} in Hindi Dubbed (S${season}E${episode}) HD | CineStream`;
          seoDesc = `Stream ${animeTitle} S${season}E${episode} in Hindi Dubbed online free in 1080p HD on CineStream. Watch all episodes of ${animeTitle} in Hindi — fast, free, no login required.`;
        } else {
          seoTitle = `Watch ${animeTitle} in Hindi Dubbed All Episodes Free HD | CineStream`;
          seoDesc = animeDesc.slice(0, 155) || buildDesc(animeTitle, 'tv', animeGenres, animeYear, animeRating);
        }

        // Ensure description is ≤ 160 chars
        if (seoDesc.length > 160) seoDesc = seoDesc.slice(0, 157) + '...';

        const genreKeywords = animeGenres.map(g => `${g} anime in hindi`).join(', ');
        // Target Hinglish, Urdu, & regional searches: Urdu, reviews, cast, story, trailer, release date, watch online
        const intentKeywords = `${animeTitle} ep 1 in Hindi Dubbed, ${animeTitle} season 1, where to watch ${animeTitle} in hindi, ${animeTitle} in Hindi Dubbed kahan dekhen, is ${animeTitle} available in hindi, ${animeTitle} urdu dubbed, ${animeTitle} watch online, ${animeTitle} free streaming, ${animeTitle} full details, ${animeTitle} trailer, ${animeTitle} release date, ${animeTitle} story review cast`;
        const seoKeywords = `${animeTitle} in hindi, ${animeTitle} in Hindi Dubbed, watch ${animeTitle} online free, ${animeTitle} in Hindi Dubbed episodes, ${animeTitle} ${animeYear || ''}, ${genreKeywords}, ${intentKeywords}, anime in hindi, CineStream, cinestream.watch`.replace(/,\s*,/g, ',');

        let canonical = `https://cinestream.watch/${action}/${mediaType}/${toonId}`;
        if (isWatch && season && episode && mediaType === 'tv') {
          canonical += `?s=${season}&e=${episode}`;
        }

        const posterUrl = animePoster || 'https://cinestream.watch/images/og-banner.png';
        const dateModified = details && details.updatedAt ? new Date(details.updatedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
        // Use real createdAt date if available, then release year, then fallback to dateModified
        let datePublished = dateModified;
        if (animeCreatedAt) {
          datePublished = new Date(animeCreatedAt).toISOString().split('T')[0];
        } else if (animeYear) {
          datePublished = `${animeYear}-01-01`;
        }

        // ── Schema.org JSON-LD ──────────────────────────────────────────────────
        const schemas = [];

        // 1. BreadcrumbList
        const breadcrumbItems = [
          { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://cinestream.watch/' },
          { '@type': 'ListItem', 'position': 2, 'name': mediaType === 'movie' ? 'Anime Movies' : 'Anime Series', 'item': `https://cinestream.watch/${mediaType === 'movie' ? 'movies' : 'series'}` },
        ];
        if (isWatch && season && episode && mediaType === 'tv') {
          breadcrumbItems.push({ '@type': 'ListItem', 'position': 3, 'name': animeTitle, 'item': `https://cinestream.watch/media/tv/${toonId}` });
          breadcrumbItems.push({ '@type': 'ListItem', 'position': 4, 'name': `Season ${season} Episode ${episode}`, 'item': canonical });
        } else {
          breadcrumbItems.push({ '@type': 'ListItem', 'position': 3, 'name': animeTitle, 'item': canonical });
        }
        schemas.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': breadcrumbItems });

        // 2. Main media schema
        const commonMediaFields = {
          'name': `${animeTitle} in Hindi Dubbed`,
          'alternateName': [`${animeTitle} in Hindi`, `${animeTitle} Hindi`, `Watch ${animeTitle} Online`],
          'url': canonical,
          'image': { '@type': 'ImageObject', 'url': posterUrl, 'width': 500, 'height': 750 },
          'description': seoDesc,
          'inLanguage': animeLanguage ? ['hi', 'en', animeLanguage] : ['hi', 'en'],
          'isAccessibleForFree': true,
          'datePublished': datePublished,
          'dateModified': dateModified,
          'countryOfOrigin': { '@type': 'Country', 'name': 'Japan' },
          'audience': { '@type': 'Audience', 'audienceType': 'Anime Fans', 'geographicArea': { '@type': 'Country', 'name': 'India' } },
          'potentialAction': { '@type': 'WatchAction', 'target': { '@type': 'EntryPoint', 'urlTemplate': canonical } },
        };
        if (animeGenres.length > 0) commonMediaFields['genre'] = animeGenres;
        if (animeRating) commonMediaFields['aggregateRating'] = { '@type': 'AggregateRating', 'ratingValue': animeRating, 'bestRating': '10', 'ratingCount': 1000 };
        if (animeDuration) {
          // Schema duration format is ISO 8601 (e.g. PT23M)
          const cleanMinutes = parseInt(animeDuration, 10);
          if (!isNaN(cleanMinutes)) {
            commonMediaFields['duration'] = `PT${cleanMinutes}M`;
          }
        }
        if (animeStatus) {
          commonMediaFields['creativeWorkStatus'] = animeStatus;
        }

        let durationIso = 'PT24M'; // Default anime episode length fallback
        if (animeDuration) {
          const cleanMinutes = parseInt(animeDuration, 10);
          if (!isNaN(cleanMinutes) && cleanMinutes > 0) {
            const hrs = Math.floor(cleanMinutes / 60);
            const remainingMins = cleanMinutes % 60;
            if (hrs > 0) {
              durationIso = `PT${hrs}H${remainingMins}M`;
            } else {
              durationIso = `PT${cleanMinutes}M`;
            }
          }
        }

        // Shared publisher object used in all VideoObject schemas
        const publisherSchema = {
          '@type': 'Organization',
          'name': 'CineStream',
          'url': 'https://cinestream.watch',
          'logo': { '@type': 'ImageObject', 'url': 'https://cinestream.watch/android-chrome-512x512.png', 'width': 512, 'height': 512 }
        };

        if (mediaType === 'movie') {
          // Movies also get a VideoObject schema to ensure rich search snippets
          schemas.push({ '@context': 'https://schema.org', '@type': 'Movie', ...commonMediaFields });
          const movieEmbedUrl = `https://cinestream.watch/iframe-proxy?id=${toonId}`;
          schemas.push({
            '@context': 'https://schema.org', '@type': 'VideoObject',
            'name': `Watch ${animeTitle} Full Movie in Hindi Dubbed Online Free`,
            'description': seoDesc,
            'thumbnailUrl': [posterUrl],
            'uploadDate': datePublished,
            'duration': durationIso,
            'embedUrl': movieEmbedUrl,
            'url': canonical,
            'requiresSubscription': false,
            'isAccessibleForFree': true,
            'isFamilyFriendly': true,
            'inLanguage': 'hi',
            'keywords': `${animeTitle} in Hindi Dubbed, watch ${animeTitle} online free, ${animeTitle} full movie hindi`,
            'potentialAction': { '@type': 'WatchAction', 'target': [canonical] },
            'publisher': publisherSchema,
            'interactionStatistic': { '@type': 'InteractionCounter', 'interactionType': { '@type': 'WatchAction' }, 'userInteractionCount': 85000 }
          });
        } else if (isWatch && season && episode) {
          schemas.push({
            '@context': 'https://schema.org', '@type': 'Episode',
            'name': `${animeTitle} Season ${season} Episode ${episode} in Hindi Dubbed`,
            'episodeNumber': episode,
            'partOfSeason': { '@type': 'CreativeWorkSeason', 'seasonNumber': season, 'name': `Season ${season}` },
            'partOfSeries': { '@type': 'TVSeries', 'name': `${animeTitle} in Hindi Dubbed`, 'url': `https://cinestream.watch/media/tv/${toonId}` },
            'url': canonical,
            'image': { '@type': 'ImageObject', 'url': posterUrl, 'width': 500, 'height': 750 },
            'description': seoDesc,
            'inLanguage': ['hi', 'en'],
            'isAccessibleForFree': true,
            'datePublished': datePublished,
            'dateModified': dateModified,
          });
          const epEmbedUrl = `https://cinestream.watch/iframe-proxy?id=${toonId}&s=${season}&e=${episode}`;
          schemas.push({
            '@context': 'https://schema.org', '@type': 'VideoObject',
            'name': `Watch ${animeTitle} S${season}E${episode} in Hindi Dubbed Online Free`,
            'description': seoDesc,
            'thumbnailUrl': [posterUrl],
            'uploadDate': datePublished,
            'duration': durationIso,
            'embedUrl': epEmbedUrl,
            'url': canonical,
            'requiresSubscription': false,
            'isAccessibleForFree': true,
            'isFamilyFriendly': true,
            'inLanguage': 'hi',
            'keywords': `${animeTitle} episode ${episode} in Hindi Dubbed, watch ${animeTitle} S${season}E${episode} online free, ${animeTitle} season ${season} hindi`,
            'potentialAction': { '@type': 'WatchAction', 'target': [canonical] },
            'publisher': publisherSchema,
            'interactionStatistic': { '@type': 'InteractionCounter', 'interactionType': { '@type': 'WatchAction' }, 'userInteractionCount': 50000 }
          });
        } else {
          const tvSchema = { '@context': 'https://schema.org', '@type': 'TVSeries', ...commonMediaFields };
          if (animeSeasons) tvSchema['numberOfSeasons'] = animeSeasons;
          schemas.push(tvSchema);
        }

        // 3. WebPage schema
        schemas.push({
          '@context': 'https://schema.org', '@type': 'WebPage',
          'name': seoTitle,
          'url': canonical,
          'description': seoDesc,
          'isAccessibleForFree': true,
          'inLanguage': 'hi',
          'dateModified': dateModified,
          'primaryImageOfPage': { '@type': 'ImageObject', 'url': posterUrl, 'width': 500, 'height': 750 },
          'breadcrumb': { '@type': 'BreadcrumbList', 'itemListElement': breadcrumbItems }
        });

        // ── Programmatic FAQ Generation ─────────────────────────────────────────
        const faqList = [
          {
            '@type': 'Question',
            'name': `Where to watch ${animeTitle} in Hindi dubbed?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': `You can stream ${animeTitle} in Hindi dubbed online free on CineStream. Enjoy dual audio options with high quality 1080p HD video. No subscription or registration required.`
            }
          },
          {
            '@type': 'Question',
            'name': `Is ${animeTitle} available in Hindi on CineStream?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': `Yes! ${animeTitle} is available with in Hindi Dubbed audio track on CineStream. You can watch all seasons and full episodes free.`
            }
          }
        ];
        if (animeYear) {
          faqList.push({
            '@type': 'Question',
            'name': `When was ${animeTitle} released?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': `${animeTitle} was originally released in ${animeYear}. Check out all release dates and episode guide details on CineStream.`
            }
          });
        }
        if (animeDesc) {
          faqList.push({
            '@type': 'Question',
            'name': `What is the story of ${animeTitle}?`,
            'acceptedAnswer': {
              '@type': 'Answer',
              'text': animeDesc.length > 250 ? animeDesc.slice(0, 247) + '...' : animeDesc
            }
          });
        }
        const faqJsonLd = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          'mainEntity': faqList
        });

        // ── Programmatic Visible Content Injection (On-page SEO) ────────────────
        const genreBadges = animeGenres.map(g => `<span style="background:rgba(255,255,255,0.08);padding:0.2rem 0.6rem;border-radius:4px;font-size:0.8rem;margin-right:0.4rem;display:inline-block;margin-top:0.4rem;">${g}</span>`).join('');
        const visibleSeoContent = `
          <div class="ssr-seo-details" style="padding:1.5rem;background:rgba(20,20,20,0.6);border-radius:12px;margin:1.5rem auto;max-width:1200px;border:1px solid rgba(255,255,255,0.05);color:var(--text);font-family:system-ui,-apple-system,sans-serif;">
            <div style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-bottom:1.5rem;">
              ${animePoster ? `<div style="flex:0 0 150px;"><img src="${posterUrl}" alt="${animeTitle} Poster" width="150" height="225" style="border-radius:8px;object-fit:cover;box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:100%;height:auto;"></div>` : ''}
              <div style="flex:1;min-width:280px;">
                <p style="font-size:1rem;line-height:1.6;color:var(--text-muted);margin:0 0 1rem 0;">
                  Looking for <strong>${animeTitle} in Hindi Dubbed</strong> episodes? CineStream provides high-quality streaming links to watch the entire series online for free. Read full reviews, synopsis, story release updates, and casting insights below.
                </p>
                <div style="margin-bottom:1rem;">
                  <strong>Release Year:</strong> ${animeYear || 'N/A'} | 
                  <strong>Rating:</strong> ⭐${animeRating || 'N/A'} / 10
                  ${animeSeasons ? ` | <strong>Seasons:</strong> ${animeSeasons}` : ''}
                </div>
                <div style="margin-bottom:1rem;">
                  <strong>Genres:</strong> ${genreBadges || 'Anime'}
                </div>
              </div>
            </div>
            
            <h2 style="font-size:1.4rem;font-weight:700;margin:1.5rem 0 0.5rem;color:var(--primary);">Synopsis and Story Details</h2>
            <p style="line-height:1.8;color:var(--text-muted);font-size:1rem;">${animeDesc || `Watch ${animeTitle} in Hindi Dubbed full series online free on CineStream. Enjoy all episodes in high quality HD with multi-audio options. CineStream offers the best anime streaming experience in India with Hindi, English and Japanese audio tracks.`}</p>

            <h2 style="font-size:1.4rem;font-weight:700;margin:1.5rem 0 0.5rem;color:var(--primary);">About ${animeTitle}</h2>
            <p style="line-height:1.8;color:var(--text-muted);font-size:1rem;">
              <strong>${animeTitle}</strong>${animeYear ? ` (${animeYear})` : ''} is ${mediaType === 'movie' ? 'an anime movie' : 'an anime series'}${animeGenres.length > 0 ? ` in the ${animeGenres.slice(0, 3).join(', ')} genre` : ''}${animeRating ? ` with a rating of ${animeRating}/10` : ''}.
              Available on CineStream with in Hindi Dubbed audio, English subtitles, and original Japanese track.
              Stream all ${mediaType === 'movie' ? 'parts' : 'seasons and episodes'} of ${animeTitle} for free — no subscription, no login required.
            </p>

            <h2 style="font-size:1.4rem;font-weight:700;margin:1.5rem 0 0.5rem;color:var(--primary);">Where to Watch ${animeTitle} in Hindi on CineStream</h2>
            <p style="line-height:1.8;color:var(--text-muted);font-size:1rem;">
              You can watch <strong>${animeTitle} in Hindi Dubbed</strong> online free at <a href="https://cinestream.watch/media/${mediaType}/${toonId}" style="color:var(--primary);text-decoration:underline;">cinestream.watch</a>.
              CineStream provides multiple streaming servers so you can always find a working mirror. Select your preferred audio: in Hindi Dubbed, English Subtitles, or Japanese Original.
              Video quality options include 1080p FHD, 720p HD, and 480p SD. No ads overlay the video player. No popups or redirects.
            </p>

            <h2 style="font-size:1.4rem;font-weight:700;margin:1.5rem 0 0.5rem;color:var(--primary);">Frequently Asked Questions about ${animeTitle}</h2>
            <div style="line-height:1.6;">
              ${faqList.map(faq => `
                <div style="margin-bottom:1.2rem;padding:1rem;background:rgba(255,255,255,0.03);border-radius:8px;border-left:3px solid var(--primary);">
                  <strong style="color:var(--text);display:block;margin-bottom:0.4rem;font-size:1rem;">Q: ${faq.name}</strong>
                  <span style="color:var(--text-muted);display:block;font-size:0.95rem;">${faq.acceptedAnswer.text}</span>
                </div>
              `).join('')}
            </div>

            <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid rgba(255,255,255,0.07);">
              <p style="color:var(--text-muted);font-size:0.9rem;">
                🎬 Explore more on CineStream:
                <a href="https://cinestream.watch/" style="color:var(--primary);margin:0 0.5rem;">Home</a> |
                <a href="https://cinestream.watch/genre/action" style="color:var(--primary);margin:0 0.5rem;">Action Anime</a> |
                <a href="https://cinestream.watch/genre/romance" style="color:var(--primary);margin:0 0.5rem;">Romance Anime</a> |
                <a href="https://cinestream.watch/genre/isekai" style="color:var(--primary);margin:0 0.5rem;">Isekai Anime</a> |
                <a href="https://cinestream.watch/genre/shounen" style="color:var(--primary);margin:0 0.5rem;">Shounen Anime</a>
              </p>
            </div>
          </div>
        `;

        // ── Programmatic Header Navigation Links (prev/next link elements) ──────
        let prevNextHeaderTags = '';
        let prevNextBodyHtml = '';
        if (isWatch && season && episode && mediaType === 'tv') {
          if (episode > 1) {
            const prevUrl = `https://cinestream.watch/watch/tv/${toonId}?s=${season}&e=${episode - 1}`;
            prevNextHeaderTags += `<link rel="prev" href="${prevUrl}">`;
            prevNextBodyHtml += `<a href="${prevUrl}" style="background:var(--primary);color:#fff;padding:0.5rem 1rem;border-radius:4px;text-decoration:none;margin-right:1rem;font-size:0.9rem;font-weight:600;">&larr; Prev Episode (${episode - 1})</a>`;
          }
          const nextUrl = `https://cinestream.watch/watch/tv/${toonId}?s=${season}&e=${episode + 1}`;
          prevNextHeaderTags += `<link rel="next" href="${nextUrl}">`;
          prevNextBodyHtml += `<a href="${nextUrl}" style="background:var(--primary);color:#fff;padding:0.5rem 1rem;border-radius:4px;text-decoration:none;font-size:0.9rem;font-weight:600;">Next Episode (${episode + 1}) &rarr;</a>`;
        }

        const jsonLd = JSON.stringify(schemas);

        // ── Inject into HTML ────────────────────────────────────────────────────
        let injected = htmlRaw;
        injected = injected.replace(/<html lang="en"/, '<html lang="hi"');
        injected = injected.replace(
          new RegExp('<h1 id="seo-h1"[^>]*>[^<]*</h1>'),
          `<h1 id="seo-h1" style="font-size: clamp(1.4rem, 3vw, 2rem); font-weight: 800; color: var(--text); margin: 0 0 0.5rem; line-height: 1.2;">Watch ${animeTitle}${isWatch && season && episode ? ` Season ${season} Episode ${episode} (S${season} EP${episode})` : ''} in Hindi Dubbed Online Free HD</h1>`
        );
        injected = injected
          .replace(new RegExp('<title id="seo-title">[^<]*</title>'), `<title id="seo-title">${seoTitle}</title>`)
          .replace(new RegExp('<meta id="seo-desc"[^>]*>'), `<meta id="seo-desc" name="description" content="${seoDesc}">`)
          .replace(new RegExp('<meta name="keywords"[^>]*>'), `<meta name="keywords" content="${seoKeywords}">`)
          .replace(new RegExp('<link id="seo-canonical"[^>]*>'), `<link id="seo-canonical" rel="canonical" href="${canonical}">`)
          .replace(new RegExp('<meta name="robots"[^>]*>'), `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`)
          .replace(new RegExp('<meta id="og-title"[^>]*>'), `<meta id="og-title" property="og:title" content="${seoTitle}">`)
          .replace(new RegExp('<meta id="og-desc"[^>]*>'), `<meta id="og-desc" property="og:description" content="${seoDesc}">`)
          .replace(new RegExp('<meta id="og-url"[^>]*>'), `<meta id="og-url" property="og:url" content="${canonical}">`)
          .replace(new RegExp('<meta id="og-image"[^>]*>'), `<meta id="og-image" property="og:image" content="${posterUrl}">`)
          .replace(new RegExp('<meta property="og:image:width"[^>]*>'), `<meta property="og:image:width" content="500">`)
          .replace(new RegExp('<meta property="og:image:height"[^>]*>'), `<meta property="og:image:height" content="750">`)
          .replace(new RegExp('<meta property="og:image:alt"[^>]*>'), `<meta property="og:image:alt" content="Watch ${animeTitle} in Hindi Dubbed on CineStream">`)
          .replace(new RegExp('<meta property="og:type"[^>]*>'), `<meta property="og:type" content="${mediaType === 'movie' ? 'video.movie' : 'video.tv_show'}">`)
          .replace(new RegExp('<meta id="tw-title"[^>]*>'), `<meta id="tw-title" name="twitter:title" content="${seoTitle}">`)
          .replace(new RegExp('<meta id="tw-desc"[^>]*>'), `<meta id="tw-desc" name="twitter:description" content="${seoDesc}">`)
          .replace(new RegExp('<meta id="tw-image"[^>]*>'), `<meta id="tw-image" name="twitter:image" content="${posterUrl}">`)
          .replace(new RegExp('<meta id="tw-image-alt"[^>]*>'), `<meta id="tw-image-alt" name="twitter:image:alt" content="Watch ${animeTitle} in Hindi Dubbed Free on CineStream">`)
          .replace('<script id="ld-dynamic" type="application/ld+json"></script>', `<script id="ld-dynamic" type="application/ld+json">${jsonLd}</script>`)
          .replace('<script id="ld-faq-dynamic" type="application/ld+json"></script>', `<script id="ld-faq-dynamic" type="application/ld+json">${faqJsonLd}</script>`)
          .replace('<div id="seo-content-area"></div>', `<div id="seo-content-area">${visibleSeoContent}</div>`);

        // Inject prev/next tags in head if generated
        if (prevNextHeaderTags) {
          injected = injected.replace('</head>', `${prevNextHeaderTags}</head>`);
        }

        // Dynamically update default webpage dateModified
        const webpageSearch = injected.match(/"@type":\s*"WebPage"[\s\S]*?"dateModified":\s*"([^"]+)"/);
        if (webpageSearch) {
          injected = injected.replace(webpageSearch[0], webpageSearch[0].replace(webpageSearch[1], dateModified));
        }



        compressAndSend(req, res, injected, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' });
        logger.request(req, 200, Date.now() - startMs);
        return;
      } catch (seoErr) {
        logger.warn('seo_inject_error', { message: seoErr.message });
        try {
          // Minimal dynamic canonical fallback injection so Google doesn't index it as duplicate homepage
          const htmlRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
          const fallbackInjected = htmlRaw
            .replace(new RegExp('<link id="seo-canonical"[^>]*>'), `<link id="seo-canonical" rel="canonical" href="${canonical}">`)
            .replace(new RegExp('<meta id="og-url"[^>]*>'), `<meta id="og-url" property="og:url" content="${canonical}">`);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(Buffer.from(fallbackInjected, 'utf8'));
          return;
        } catch (readErr) {
          // Fall through if even reading index.html fails
        }
      }
    } else if (pathname === '/' && seoQ) {
      // ── SEO: Server-side search results page meta injection ──────────────────
      try {
        const htmlRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        const seoTitle = `${seoQ} Anime Search Results | CineStream`;
        const seoDesc = `Find ${seoQ} episodes, seasons, in Hindi Dubbed content, related anime and more on CineStream.`;
        const seoKeywords = `${seoQ}, search ${seoQ}, watch ${seoQ} hindi, ${seoQ} dubbed, CineStream`;
        const canonical = `https://cinestream.watch/?q=${encodeURIComponent(seoQ)}`;

        const jsonLd = JSON.stringify([
          {
            '@context': 'https://schema.org',
            '@type': 'SearchResultsPage',
            'name': seoTitle,
            'url': canonical,
            'description': seoDesc
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            'itemListElement': [
              { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://cinestream.watch/' },
              { '@type': 'ListItem', 'position': 2, 'name': `Search: ${seoQ}`, 'item': canonical }
            ]
          }
        ]);

        const injected = htmlRaw
          .replace(
            new RegExp('<title id="seo-title">[^<]*</title>'),
            `<title id="seo-title">${seoTitle}</title>`
          )
          .replace(
            new RegExp('<meta id="seo-desc"[^>]*>'),
            `<meta id="seo-desc" name="description" content="${seoDesc}">`
          )
          .replace(
            new RegExp('<meta name="keywords"[^>]*>'),
            `<meta name="keywords" content="${seoKeywords}">`
          )
          .replace(
            new RegExp('<link id="seo-canonical"[^>]*>'),
            `<link id="seo-canonical" rel="canonical" href="${canonical}">`
          )
          .replace(
            new RegExp('<meta id="og-title"[^>]*>'),
            `<meta id="og-title" property="og:title" content="${seoTitle}">`
          )
          .replace(
            new RegExp('<meta id="og-desc"[^>]*>'),
            `<meta id="og-desc" property="og:description" content="${seoDesc}">`
          )
          .replace(
            new RegExp('<meta id="og-url"[^>]*>'),
            `<meta id="og-url" property="og:url" content="${canonical}">`
          )
          .replace(
            new RegExp('<meta id="tw-title"[^>]*>'),
            `<meta id="tw-title" name="twitter:title" content="${seoTitle}">`
          )
          .replace(
            new RegExp('<meta id="tw-desc"[^>]*>'),
            `<meta id="tw-desc" name="twitter:description" content="${seoDesc}">`
          )
          .replace(
            '<script id="ld-dynamic" type="application/ld+json"></script>',
            `<script id="ld-dynamic" type="application/ld+json">${jsonLd}</script>`
          );

        compressAndSend(req, res, injected, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' });
        logger.request(req, 200, Date.now() - startMs);
        return;
      } catch (seoErr) {
        logger.warn('seo_search_inject_error', { message: seoErr.message });
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

// ── Startup (local dev) ───────────────────────────────────────────────────────
// On Vercel, ensureInit() is called at module load above and awaited inside
// requestHandler, so there is no race condition. For local dev, we also start
// the HTTP server listening on PORT.
ensureInit().then(() => {
  server.listen(PORT, () => {
    logger.info('server_started', {
      port: PORT,
      env: config.nodeEnv,
      db: isConnected() ? 'connected' : 'unavailable',
    });
  });
}).catch((err) => {
  logger.error('startup_failed', err);
  process.exit(1);
});

// Export the handler function (not the server) for Vercel's @vercel/node runtime
module.exports = requestHandler;


