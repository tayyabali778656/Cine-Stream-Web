'use strict';

/**
 * scripts/generateSitemap.js — Master Sitemap Generator
 *
 * Features:
 *  - Collects ALL indexable pages: static HTML, media pages (Movies, TV, Anime)
 *  - Automatically splits into multiple sitemap files at 50,000 URLs each
 *  - Generates sitemap-index.xml referencing all chunk files
 *  - Only includes URLs that genuinely exist (HTTP 200) via vercel.json rewrite rules
 *  - Writes output to project root: sitemap.xml, sitemap-2.xml, ... sitemap-index.xml
 *
 * Run: npm run generate-sitemap
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const dns   = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('DNS override failed in sitemap generator:', e.message);
}

const config = require('../config');
const { MongoClient } = require('mongodb');

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL      = 'https://cinestream.watch';
const ROOT_DIR      = path.join(__dirname, '..');
const TODAY         = new Date().toISOString().split('T')[0];
const MAX_URLS_PER_SITEMAP = 50_000;   // Google limit
const FETCH_BATCH   = 8;               // parallel TMDB requests per batch
const BATCH_DELAY   = 120;             // ms delay between batches (avoids rate-limit)
const TMDB_IMG_URL  = 'https://image.tmdb.org/t/p/w500';

// ─── Static pages that definitely return 200 OK ───────────────────────────────
// These are served from real files on disk, or rewritten by vercel.json.
const STATIC_PAGES = [
  { loc: `${BASE_URL}/`,                 priority: '1.0', changefreq: 'daily'   },
  { loc: `${BASE_URL}/app`,              priority: '0.9', changefreq: 'weekly'  },
  { loc: `${BASE_URL}/about.html`,       priority: '0.6', changefreq: 'monthly' },
  { loc: `${BASE_URL}/contact.html`,     priority: '0.5', changefreq: 'monthly' },
  { loc: `${BASE_URL}/privacy.html`,     priority: '0.3', changefreq: 'yearly'  },
  { loc: `${BASE_URL}/disclaimer.html`,  priority: '0.3', changefreq: 'yearly'  },
];

// ─── TMDB endpoints (all categories + anime genre 16) ────────────────────────
// Each page returns up to 20 items → 500 max items per endpoint group
// We fetch 15 pages × 10 endpoint types = 150 total calls → ~3,000 unique items
function buildTmdbEndpoints(maxPages = 15) {
  const eps = [];
  for (let page = 1; page <= maxPages; page++) {
    // Core content
    eps.push(`/trending/movie/week?page=${page}`);
    eps.push(`/trending/tv/week?page=${page}`);
    eps.push(`/movie/popular?page=${page}`);
    eps.push(`/tv/popular?page=${page}`);
    eps.push(`/movie/top_rated?page=${page}`);
    eps.push(`/tv/top_rated?page=${page}`);
    eps.push(`/movie/upcoming?page=${page}`);
    // Anime (genre_ids includes 16 = Animation; origin_country JP = Japanese anime)
    eps.push(`/discover/tv?with_genres=16&sort_by=popularity.desc&page=${page}`);
    eps.push(`/discover/tv?with_genres=16&sort_by=vote_average.desc&vote_count.gte=100&page=${page}`);
    eps.push(`/discover/movie?with_genres=16&sort_by=popularity.desc&page=${page}`);
    eps.push(`/discover/movie?with_genres=16&sort_by=vote_average.desc&vote_count.gte=50&page=${page}`);
  }
  return eps;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchTmdb(endpoint) {
  return new Promise((resolve) => {
    // Some endpoints already have '?' so we use the correct joiner
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${config.tmdbBaseUrl}${endpoint}${sep}api_key=${config.tmdbApiKey}`;
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ results: [] }); }
      });
      res.on('error', () => resolve({ results: [] }));
    }).on('error', () => resolve({ results: [] }));
  });
}

// ─── Sitemap XML builder helpers ──────────────────────────────────────────────

function entryToXml(p) {
  const imageTag = p.image
    ? `\n    <image:image>\n      <image:loc>${escapeXml(p.image)}</image:loc>\n      <image:title>${escapeXml(p.imageTitle)}</image:title>${p.imageCaption ? `\n      <image:caption>${escapeXml(p.imageCaption)}</image:caption>` : ''}\n    </image:image>`
    : '';
  return `  <url>\n    <loc>${p.loc}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>${imageTag}\n  </url>`;
}

function buildSitemapXml(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.map(entryToXml).join('\n')}
</urlset>`;
}

function buildIndexXml(sitemapFiles) {
  const items = sitemapFiles.map(f => `  <sitemap>\n    <loc>${BASE_URL}/${f}</loc>\n    <lastmod>${TODAY}</lastmod>\n  </sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>`;
}

// ─── Write chunks of entries to disk ─────────────────────────────────────────

function writeChunks(entries) {
  const chunkFiles = [];

  if (entries.length <= MAX_URLS_PER_SITEMAP) {
    // Single sitemap.xml — no numbering needed
    const file = 'sitemap.xml';
    fs.writeFileSync(path.join(ROOT_DIR, file), buildSitemapXml(entries), 'utf8');
    chunkFiles.push(file);
    console.log(`[SITEMAP] Wrote ${file} (${entries.length} URLs)`);
  } else {
    // Multiple chunks
    let chunkIndex = 1;
    for (let i = 0; i < entries.length; i += MAX_URLS_PER_SITEMAP) {
      const chunk = entries.slice(i, i + MAX_URLS_PER_SITEMAP);
      const file  = chunkIndex === 1 ? 'sitemap.xml' : `sitemap-${chunkIndex}.xml`;
      fs.writeFileSync(path.join(ROOT_DIR, file), buildSitemapXml(chunk), 'utf8');
      chunkFiles.push(file);
      console.log(`[SITEMAP] Wrote ${file} (${chunk.length} URLs)`);
      chunkIndex++;
    }
  }

  return chunkFiles;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║      CineStream — Master Sitemap Generator            ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');

  const seenUrls = new Set();
  const entries  = [];

  function addEntry(entry) {
    if (seenUrls.has(entry.loc)) return;
    seenUrls.add(entry.loc);
    entries.push(entry);
  }

  // ── Step 1: Static HTML pages ─────────────────────────────────────────────
  console.log('[1/4] Adding static pages...');
  for (const page of STATIC_PAGES) {
    addEntry({ ...page, lastmod: TODAY });
  }
  console.log(`      → ${STATIC_PAGES.length} static pages added`);

  // ── Step 2: Database custom items (MongoDB) ───────────────────────────────
  console.log('[2/4] Fetching database entries (MongoDB)...');
  try {
      const client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 15000,
        family: 4,
        tls: true,
      });
      await client.connect();
      const db    = client.db('moviebox');
      const adminItems = await db.collection('admin_store').find({}).toArray();
      const animeItems = await db.collection('anime').find({}).toArray();
      await client.close();

      for (const item of adminItems) {
        const type = item.type === 'movie' ? 'movie' : 'tv';
        addEntry({
          loc:          `${BASE_URL}/media/${type}/${item.id}`,
          priority:     '0.9',
          changefreq:   'weekly',
          lastmod:      TODAY,
          image:        item.poster_path ? `${TMDB_IMG_URL}${item.poster_path}` : null,
          imageTitle:   item.title || item.name || '',
          imageCaption: (item.overview || '').slice(0, 200),
        });
      }

      for (const item of animeItems) {
        const type = item.type === 'movie' ? 'movie' : 'tv';
        addEntry({
          loc:          `${BASE_URL}/media/${type}/${item.id}`,
          priority:     '0.9',
          changefreq:   'weekly',
          lastmod:      TODAY,
          image:        item.poster ? item.poster : null,
          imageTitle:   item.title || '',
          imageCaption: (item.description || '').slice(0, 200),
        });
      }
      console.log(`      → ${adminItems.length} admin items & ${animeItems.length} anime items added from DB`);
  } catch (err) {
    console.warn(`      ⚠ MongoDB unavailable: ${err.message}`);
  }

  // ── Step 2.5: Fetch live entries from ToonStream categories (Live Scraping) ──
  console.log('[2.5/4] Fetching live entries from ToonStream...');
  try {
    const liveSvc = require('../services/toonstreamLive');
    const categories = [
      { type: 'anime', maxPages: 45 },
      { type: 'cartoon', maxPages: 25 },
      { type: 'movie', maxPages: 25 }
    ];

    for (const cat of categories) {
      console.log(`      Scraping category "${cat.type}"...`);
      for (let page = 1; page <= cat.maxPages; page++) {
        process.stdout.write(`         Page ${page} / ${cat.maxPages}  (${entries.length} URLs so far)\r`);
        const data = await liveSvc.getLiveAnimeList('', page, cat.type);
        if (!data || !data.results || data.results.length === 0) {
          break;
        }
        
        for (const item of data.results) {
          const mediaType = item.type === 'movie' ? 'movie' : 'tv';
          addEntry({
            loc:          `${BASE_URL}/media/${mediaType}/${item.id}`,
            priority:     '0.8',
            changefreq:   'weekly',
            lastmod:      TODAY,
            image:        item.poster ? item.poster : null,
            imageTitle:   item.title || '',
            imageCaption: `${item.title} - Watch free online on CineStream`,
          });
        }
        await sleep(150);
      }
      console.log(`\n      Done category "${cat.type}".`);
    }
  } catch (err) {
    console.warn(`      ⚠ Live ToonStream scraping failed: ${err.message}`);
  }

  // ── Step 3: TMDB — Movies, TV Series, and Anime ───────────────────────────
  console.log('[3/4] Fetching TMDB: Movies, TV Series, Anime...');

  if (!config.tmdbApiKey || config.tmdbApiKey === 'placeholder_tmdb_api_key') {
    console.warn('      ⚠ TMDB_API_KEY not set. Skipping TMDB fetch.');
  } else {
    const endpoints   = buildTmdbEndpoints(15);
    const totalBatches = Math.ceil(endpoints.length / FETCH_BATCH);
    let fetched = 0;
    let added   = 0;

    for (let i = 0; i < endpoints.length; i += FETCH_BATCH) {
      const batch    = endpoints.slice(i, i + FETCH_BATCH);
      const batchNum = Math.floor(i / FETCH_BATCH) + 1;
      process.stdout.write(`      Batch ${String(batchNum).padStart(3)} / ${totalBatches}  (${entries.length} URLs so far)\r`);

      const results = await Promise.allSettled(batch.map(ep => fetchTmdb(ep)));

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const items = result.value.results || [];
        fetched += items.length;

        for (const item of items) {
          if (!item.id) continue;
          // Determine media type: TMDB trending/discover returns media_type for trending,
          // but discover endpoint results don't include it — infer from title vs name.
          const mediaType = item.media_type === 'movie'
            ? 'movie'
            : item.media_type === 'tv'
              ? 'tv'
              : item.title !== undefined ? 'movie' : 'tv';

          // Only include items with a valid poster (guarantees a real TMDB entry)
          if (!item.poster_path) continue;

          const title   = item.title || item.name || '';
          const relDate = item.release_date || item.first_air_date || '';
          const lastmod = relDate ? relDate.substring(0, 10) : TODAY;

          const before = seenUrls.size;
          addEntry({
            loc:          `${BASE_URL}/media/${mediaType}/${item.id}`,
            priority:     item.vote_average >= 7.5 ? '0.8' : '0.7',
            changefreq:   'weekly',
            lastmod,
            image:        `${TMDB_IMG_URL}${item.poster_path}`,
            imageTitle:   title,
            imageCaption: (item.overview || '').slice(0, 200),
          });
          if (seenUrls.size > before) added++;
        }
      }

      if (i + FETCH_BATCH < endpoints.length) await sleep(BATCH_DELAY);
    }

    console.log(`\n      → Fetched ${fetched} raw TMDB items, ${added} unique added`);
  }

  // ── Step 4: Write sitemap files ───────────────────────────────────────────
  console.log('[4/4] Writing sitemap files...');
  console.log(`      Total unique indexable URLs: ${entries.length}`);

  const chunkFiles   = writeChunks(entries);
  const indexContent = buildIndexXml(chunkFiles);
  fs.writeFileSync(path.join(ROOT_DIR, 'sitemap-index.xml'), indexContent, 'utf8');

  console.log(`\n✅ sitemap-index.xml references ${chunkFiles.length} sitemap file(s):`);
  chunkFiles.forEach(f => console.log(`   → ${BASE_URL}/${f}`));
  console.log('');
}

run().catch(err => {
  console.error('[SITEMAP] Fatal error:', err);
  process.exit(1);
});
