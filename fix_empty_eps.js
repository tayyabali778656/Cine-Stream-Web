/**
 * Fix empty episode sources for a specific anime by scraping AnimeKai
 * Usage: node fix_empty_eps.js [animeSlug] [akSlug]
 * Example: node fix_empty_eps.js hanaori-san-still-wants-to-fight-in-the-next-life hanaori-san-still-wants-to-fight-in-the-next-life
 */
'use strict';

require('dotenv').config();
const https = require('https');
const { connectDB, getCollection } = require('./db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Slug from CLI args or default
const DB_SLUG = process.argv[2] || 'hanaori-san-still-wants-to-fight-in-the-next-life';
const AK_SLUG = process.argv[3] || DB_SLUG;
const BASE_URL = 'https://animekai.be';

function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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

async function scrapeEpisodeSources(akSlug, epNum) {
  const urls = [
    `/watch/${akSlug}/ep-${epNum}`,
    `/watch/${akSlug}-sub/ep-${epNum}`,
    `/watch/${akSlug}-dub/ep-${epNum}`,
  ];

  for (const epUrl of urls) {
    const { html, status } = await fetchPage(epUrl);
    if (!html || status === 404) continue;

    const sources = [];
    // Method 1: data-url on server spans
    const serverRegex = /<span class="server[^"]*"[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = serverRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.startsWith('http')) continue;
      const label = match[2].trim().replace(/<[^>]+>/g, '');
      const isDub = url.includes('/dub') || epUrl.includes('-dub');
      const suffix = isDub ? ' (Dub)' : ' (Sub)';
      sources.push({ url, type: 'iframe', label: `AnimeKai ${label}${suffix}`, trusted: true });
    }

    // Method 2: megaplay.buzz pattern
    if (sources.length === 0) {
      const megaRegex = /https:\/\/megaplay\.buzz\/stream\/[^\s"'<>]+/gi;
      const megaMatches = html.match(megaRegex) || [];
      megaMatches.forEach((url, idx) => {
        const isDub = url.includes('/dub');
        sources.push({
          url,
          type: 'iframe',
          label: `AnimeKai Server ${idx + 1} (${isDub ? 'Dub' : 'Sub'})`,
          trusted: true
        });
      });
    }

    if (sources.length > 0) {
      console.log(`  ✅ EP${epNum} from ${epUrl}: ${sources.length} sources`);
      return sources;
    }
  }

  console.log(`  ❌ EP${epNum}: No sources found`);
  return [];
}

async function run() {
  console.log(`\n🔧 Fixing empty episodes for: ${DB_SLUG}`);
  console.log(`🌐 AnimeKai slug: ${AK_SLUG}\n`);

  await connectDB();
  const col = getCollection('episodes');

  // Get all episodes for this anime
  const allEps = await col.find({ animeSlug: DB_SLUG }).sort({ season: 1, episode: 1 }).toArray();

  if (allEps.length === 0) {
    console.log('❌ No episodes found in DB for this anime!');
    process.exit(1);
  }

  console.log(`📋 Total episodes in DB: ${allEps.length}`);

  // Filter episodes with empty sources
  const emptyEps = allEps.filter(ep => !ep.sources || ep.sources.length === 0);
  const withSources = allEps.filter(ep => ep.sources && ep.sources.length > 0);

  console.log(`✅ With sources: ${withSources.length}`);
  console.log(`❌ Empty sources: ${emptyEps.length}`);

  if (emptyEps.length === 0) {
    console.log('\n🎉 All episodes already have sources!');
    process.exit(0);
  }

  console.log('\nStarting scrape from AnimeKai...\n');

  // First get episode list from AnimeKai to understand numbering
  const { html: indexHtml } = await fetchPage(`/watch/${AK_SLUG}`);
  const epLinkRegex = new RegExp(`href="[^"]*/watch/${AK_SLUG}/ep-(\\d+)"`, 'gi');
  let epMatch;
  const akEpNums = new Set();
  while ((epMatch = epLinkRegex.exec(indexHtml)) !== null) {
    akEpNums.add(parseInt(epMatch[1], 10));
  }

  console.log(`📺 AnimeKai episodes found: ${akEpNums.size > 0 ? Array.from(akEpNums).sort((a,b)=>a-b).join(', ') : 'None (will try by episode number directly)'}`);

  let fixed = 0;
  let failed = 0;

  for (const ep of emptyEps) {
    console.log(`\nProcessing S${ep.season}E${ep.episode} (DB id: ${ep.id})`);

    // Try matching by episode number directly
    const akEpNum = ep.episode; // For single-season anime, episode number matches AK episode
    const sources = await scrapeEpisodeSources(AK_SLUG, akEpNum);

    if (sources.length > 0) {
      await col.updateOne(
        { _id: ep._id },
        { $set: { sources, updatedAt: new Date(), akUpdatedAt: new Date() } }
      );
      console.log(`  💾 Saved ${sources.length} sources to DB`);
      fixed++;
    } else {
      failed++;
    }

    // Rate limit: wait 1.5s between requests
    await sleep(1500);
  }

  console.log(`\n================================`);
  console.log(`✅ Fixed: ${fixed} episodes`);
  console.log(`❌ Failed: ${failed} episodes`);
  console.log(`================================\n`);

  // Show final state
  const finalEps = await col.find({ animeSlug: DB_SLUG }).sort({ season: 1, episode: 1 }).toArray();
  console.log('Final state:');
  finalEps.forEach(ep => {
    const srcCount = ep.sources ? ep.sources.length : 0;
    const status = srcCount > 0 ? '✅' : '❌';
    console.log(`  ${status} S${ep.season}E${ep.episode}: ${srcCount} sources`);
  });

  process.exit(0);
}

run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
