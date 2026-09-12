/**
 * Bulk Toonstream Source Filler
 * Scans ALL toon_ anime in DB, finds episodes with empty sources,
 * and extracts the raw iframes from Toonstream using scrapeEpisodePlayer
 *
 * Uses toonstream.vip (no Cloudflare block) instead of toon-stream.site
 *
 * Usage: node scripts/bulk_toonstream_fix.js
 */
'use strict';

require('dotenv').config();
const https = require('https');
const { connectDB, getCollection } = require('../db');
const { getPlayServerFromFallback } = require('../services/toonstreamLive');
const logger = require('../utils/logger');

// Use toonstream.vip - no Cloudflare block
const VIP_BASE = 'https://toonstream.vip';

// Custom fetchPage using toonstream.vip
function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${VIP_BASE}${url}`;
  return new Promise((resolve) => {
    const attempt = (n) => {
      const req = https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Referer': VIP_BASE,
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', () => resolve({ html: '', status: 500 }));
      });
      req.on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else resolve({ html: '', status: 500 });
      });
      req.on('timeout', () => {
        req.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else resolve({ html: '', status: 504 });
      });
    };
    attempt(retries);
  });
}

// Scrape episode player from toonstream.vip
async function scrapeVipEpisodePlayer(epUrl) {
  try {
    // Convert any domain to toonstream.vip
    let vipUrl = epUrl;
    if (epUrl.startsWith('/')) {
      vipUrl = `${VIP_BASE}${epUrl}`;
    } else if (epUrl.includes('toon-stream.site')) {
      vipUrl = epUrl.replace('https://toon-stream.site', VIP_BASE).replace('http://toon-stream.site', VIP_BASE);
    } else if (!epUrl.startsWith('http')) {
      vipUrl = `${VIP_BASE}/${epUrl}`;
    }

    const { html, status } = await fetchPage(vipUrl);
    if (!html || status !== 200) return [];

    // Parse server name map: options-N -> server name
    const serverMap = {};
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
      const classMatch = liHtml.match(/<span[^>]*class=["']server["'][^>]*>([\s\S]*?)<\/span>/i);
      if (hrefMatch && classMatch) {
        serverMap[hrefMatch[1]] = classMatch[1].trim();
      }
    }

    // Parse embed URLs: options-N -> embed URL
    const embedMap = {};
    const optionDivRegex = /id=["']?(options-\d+)["']?[\s\S]*?(?:\bsrc\b|\bdata-src\b)=["']([^"']+)["']/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `${VIP_BASE}${embedUrl}`;
      if (!embedMap[optMatch[1]]) embedMap[optMatch[1]] = embedUrl;
    }

    const servers = [];
    for (const [optId, embedUrl] of Object.entries(embedMap)) {
      // Filter out ads/tracking
      if (embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
          embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
          embedUrl.includes('youtube.com')) continue;

      let realUrl = embedUrl;
      // If it's an internal embed proxy, follow it to get the real iframe
      if (embedUrl.includes(VIP_BASE) || embedUrl.includes('toon-stream.site')) {
        try {
          const { html: embedHtml } = await fetchPage(embedUrl);
          if (embedHtml) {
            const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i) ||
                                embedHtml.match(/<iframe[^>]+data-src=["']([^"']+)["']/i);
            if (iframeMatch) {
              realUrl = iframeMatch[1];
              if (realUrl.startsWith('//')) realUrl = 'https:' + realUrl;
              if (realUrl.startsWith('/')) realUrl = `${VIP_BASE}${realUrl}`;
            }
          }
        } catch (_) {}
      }

      const label = serverMap[optId] || 'Server';
      servers.push({ url: realUrl, type: 'iframe', label, language: 'Sub' });
    }

    return servers;
  } catch (err) {
    logger.error(`scrapeVipEpisodePlayer error: ${epUrl}`, err);
    return [];
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const startTime = Date.now();
  console.log('════════════════════════════════');
  console.log('🚀 Starting Toonstream Bulk Fix Crawler...');
  console.log('════════════════════════════════\n');

  await connectDB();
  const episodesCol = getCollection('episodes');

  // 1. Find all distinct animeId that start with "toon_" and have empty sources
  console.log('🔍 Finding Toonstream animes with empty episodes...');
  const emptyEpsPipeline = await episodesCol.aggregate([
    { $match: { animeId: { $regex: /^toon_/ }, $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }] } },
    { $group: { _id: '$animeId', count: { $sum: 1 }, slug: { $first: '$animeSlug' } } }
  ]).toArray();

  if (emptyEpsPipeline.length === 0) {
    console.log('✅ No empty Toonstream episodes found! Everything is fixed.');
    process.exit(0);
  }

  console.log(`📋 Found ${emptyEpsPipeline.length} animes with missing Toonstream sources.\n`);

  let totalAnimeDone = 0;
  let totalEpFixed = 0;
  let totalEpFailed = 0;

  for (const group of emptyEpsPipeline) {
    const { _id: animeId, count: emptyCount, slug } = group;

    process.stdout.write(`\n[${totalAnimeDone + 1}/${emptyEpsPipeline.length}] ${slug} (${emptyCount} empty eps) → `);

    // Get all empty episodes for this anime
    const emptyEps = await episodesCol.find({
      animeId,
      $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }]
    }).sort({ season: 1, episode: 1 }).toArray();

    let animeFixed = 0;
    let animeFailed = 0;

    for (const ep of emptyEps) {
      if (!ep.url) {
        animeFailed++;
        totalEpFailed++;
        process.stdout.write('⚠️ ');
        continue;
      }

      try {
        let sources = await scrapeVipEpisodePlayer(ep.url);

        const hasPlayServer = sources.some(s => s.label && s.label.toLowerCase() === 'play');
        if (sources.length === 0 || !hasPlayServer) {
          const fallbackSources = await getPlayServerFromFallback(slug, ep.season, ep.episode);
          if (fallbackSources && fallbackSources.length > 0) {
            if (sources.length === 0) {
              sources = fallbackSources;
            } else {
              const fallbackPlay = fallbackSources.filter(s => s.label && s.label.toLowerCase() === 'play');
              sources.push(...fallbackPlay);
            }
          }
        }

        if (sources.length > 0) {
          await episodesCol.updateOne(
            { _id: ep._id },
            { $set: { sources, updatedAt: new Date(), tsUpdatedAt: new Date() } }
          );
          animeFixed++;
          totalEpFixed++;
          process.stdout.write('✅');
        } else {
          animeFailed++;
          totalEpFailed++;
          process.stdout.write('❌');
        }
      } catch (err) {
        logger.error(`Error scraping ep ${ep.url}`, err);
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
  console.log(`⏱️  Time Taken      : ${mins}m ${secs}s`);
  console.log('════════════════════════════════\n');

  process.exit(0);
}

run().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  process.exit(1);
});
