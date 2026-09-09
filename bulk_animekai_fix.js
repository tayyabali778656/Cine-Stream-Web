/**
 * Bulk AnimeKai Source Filler
 * Scans ALL anime in DB, finds episodes with empty sources,
 * and fills them from AnimeKai (animekai.be)
 *
 * Usage: node bulk_animekai_fix.js
 */
'use strict';

require('dotenv').config();
const https = require('https');
const { connectDB, getCollection } = require('./db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE_URL = 'https://animekai.be';

// ── HTTP Fetch ────────────────────────────────────────────────────────────────
function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 404) { resolve({ html: '', status: 404 }); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', reject);
      }).on('error', (err) => {
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else reject(err);
      }).on('timeout', function () {
        this.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1), 3000);
        else reject(new Error(`Timeout: ${fullUrl}`));
      });
    };
    attempt(retries);
  });
}

// ── Scrape episode sources from AnimeKai ─────────────────────────────────────
async function scrapeEpisodeSources(akSlug, epNum) {
  const candidates = [
    `/watch/${akSlug}/ep-${epNum}`,
    `/watch/${akSlug}-sub/ep-${epNum}`,
    `/watch/${akSlug}-dub/ep-${epNum}`,
  ];

  for (const epUrl of candidates) {
    try {
      const { html, status } = await fetchPage(epUrl);
      if (!html || status === 404) continue;

      const sources = [];

      // Method 1: data-url on server spans
      const serverRegex = /<span class="server[^"]*"[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
      let match;
      while ((match = serverRegex.exec(html)) !== null) {
        const url = match[1];
        if (!url.startsWith('http')) continue;
        const label = match[2].trim().replace(/<[^>]+>/g, '').trim();
        const isDub = url.includes('/dub') || epUrl.includes('-dub');
        sources.push({ url, type: 'iframe', label: `AnimeKai ${label} (${isDub ? 'Dub' : 'Sub'})`, trusted: true });
      }

      // Method 2: megaplay.buzz direct links
      if (sources.length === 0) {
        const megaRegex = /https:\/\/megaplay\.buzz\/stream\/[^\s"'<>]+/gi;
        const megaMatches = [...new Set(html.match(megaRegex) || [])];
        megaMatches.forEach((url, idx) => {
          const isDub = url.includes('/dub');
          sources.push({
            url, type: 'iframe',
            label: `AnimeKai Server ${idx + 1} (${isDub ? 'Dub' : 'Sub'})`,
            trusted: true
          });
        });
      }

      if (sources.length > 0) return { sources, foundAt: epUrl };
    } catch (e) {
      // silently continue
    }
  }
  return { sources: [], foundAt: null };
}

// ── Get available episode numbers from AnimeKai page ─────────────────────────
async function getAkEpisodeNumbers(akSlug) {
  const slugsToTry = [akSlug, `${akSlug}-sub`, `${akSlug}-dub`];
  for (const slug of slugsToTry) {
    try {
      const { html } = await fetchPage(`/watch/${slug}`);
      if (!html) continue;
      const epLinkRegex = new RegExp(`href="[^"]*/watch/${slug}/ep-(\\d+)"`, 'gi');
      let m;
      const nums = new Set();
      while ((m = epLinkRegex.exec(html)) !== null) nums.add(parseInt(m[1], 10));
      if (nums.size > 0) return { nums: Array.from(nums).sort((a, b) => a - b), akSlug: slug };
    } catch (e) { /* continue */ }
  }
  return { nums: [], akSlug };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('🚀 Bulk AnimeKai Source Filler Started\n');
  const startTime = Date.now();

  await connectDB();
  const episodesCol = getCollection('episodes');
  const animeCol = getCollection('anime');

  // 1. Find all anime slugs that have at least one episode with empty sources
  const emptyEpDocs = await episodesCol.aggregate([
    { $match: { $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }] } },
    { $group: { _id: '$animeSlug', count: { $sum: 1 }, animeId: { $first: '$animeId' } } },
    { $sort: { count: -1 } }
  ]).toArray();

  console.log(`📊 Found ${emptyEpDocs.length} anime with empty episode sources\n`);

  if (emptyEpDocs.length === 0) {
    console.log('🎉 All episodes already have sources! Nothing to do.');
    process.exit(0);
  }

  // Stats
  let totalAnimeDone = 0;
  let totalEpFixed = 0;
  let totalEpFailed = 0;
  let totalAnimeSkipped = 0;

  for (const animeDoc of emptyEpDocs) {
    const dbSlug = animeDoc._id;
    const animeId = animeDoc.animeId || `toon_${dbSlug}`;
    const emptyCount = animeDoc.count;

    process.stdout.write(`\n[${totalAnimeDone + 1}/${emptyEpDocs.length}] ${dbSlug} (${emptyCount} empty eps) → `);

    // 2. Get AnimeKai episode list for this slug
    const { nums: akNums, akSlug } = await getAkEpisodeNumbers(dbSlug);

    if (akNums.length === 0) {
      console.log('❌ Not found on AnimeKai');
      totalAnimeSkipped++;
      totalAnimeDone++;
      await sleep(500);
      continue;
    }

    console.log(`✅ AK slug: ${akSlug} | ${akNums.length} eps on AK`);

    // 3. Get all empty episodes for this anime from DB
    const emptyEps = await episodesCol.find({
      animeSlug: dbSlug,
      $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }]
    }).sort({ season: 1, episode: 1 }).toArray();

    let animeFixed = 0;
    let animeFailed = 0;

    for (const ep of emptyEps) {
      const epNum = ep.episode; // assuming 1:1 mapping (single-season shows)
      const { sources } = await scrapeEpisodeSources(akSlug.replace('-sub', '').replace('-dub', ''), epNum);

      if (sources.length > 0) {
        await episodesCol.updateOne(
          { _id: ep._id },
          { $set: { sources, updatedAt: new Date(), akUpdatedAt: new Date() } }
        );
        animeFixed++;
        totalEpFixed++;
        process.stdout.write('✅');
      } else {
        animeFailed++;
        totalEpFailed++;
        process.stdout.write('❌');
      }

      await sleep(1200); // polite delay
    }

    console.log(`  → Fixed: ${animeFixed}, Failed: ${animeFailed}`);
    totalAnimeDone++;

    // Extra delay between anime
    await sleep(1000);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  console.log('\n════════════════════════════════');
  console.log(`✅ Episodes Fixed  : ${totalEpFixed}`);
  console.log(`❌ Episodes Failed : ${totalEpFailed}`);
  console.log(`⏭️  Anime Skipped   : ${totalAnimeSkipped} (not on AnimeKai)`);
  console.log(`⏱️  Time Taken      : ${mins}m ${secs}s`);
  console.log('════════════════════════════════\n');

  process.exit(0);
}

run().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  process.exit(1);
});
