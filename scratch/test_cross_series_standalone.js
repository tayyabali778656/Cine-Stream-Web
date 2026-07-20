// Temporarily add scrapeEpisodePlayer to exports to test it
// We'll call it through getLiveEpisodes but directly scrape first
const https = require('https');
const logger = require('../utils/logger');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(url, retries = 2) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve) => {
    const attempt = (n) => {
      const req = https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 404) { resolve({ html: '', status: 404 }); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', () => resolve({ html: '', status: 500 }));
      });
      req.on('error', () => { if (n > 0) setTimeout(() => attempt(n - 1), 1000); else resolve({ html: '', status: 500 }); });
      req.on('timeout', () => { req.destroy(); if (n > 0) setTimeout(() => attempt(n - 1), 1000); else resolve({ html: '', status: 504 }); });
    };
    attempt(retries);
  });
}

async function scrapeEpisodePlayer(epUrl, _depth = 0) {
  const { html } = await fetchPage(epUrl);
  if (!html) return [];

  const serverMap = {};
  const liRegex = /<li>([\s\S]*?)<\/li>/gi;
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const liHtml = liMatch[1];
    const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
    const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
    const numMatch = liHtml.match(/<span>\s*(\d+)\s*<\/span>/);
    if (hrefMatch && nameMatch) {
      serverMap[hrefMatch[1]] = { name: nameMatch[1].trim(), num: numMatch ? parseInt(numMatch[1]) : Object.keys(serverMap).length + 1 };
    }
  }

  const embedMap = {};
  const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:\bsrc\b|\bdata-src\b)="([^"]+)"/gi;
  let optMatch;
  while ((optMatch = optionDivRegex.exec(html)) !== null) {
    let embedUrl = optMatch[2];
    if (embedUrl.startsWith('/')) embedUrl = `${BASE_URL}${embedUrl}`;
    if (!embedMap[optMatch[1]]) embedMap[optMatch[1]] = embedUrl;
  }

  const servers = [];
  const optionIds = Object.keys(embedMap).sort((a, b) => parseInt(a.replace('options-', '')) - parseInt(b.replace('options-', '')));
  for (const optId of optionIds) {
    const embedUrl = embedMap[optId];
    if (embedUrl.includes('google') || embedUrl.includes('doubleclick') || embedUrl.includes('facebook') || embedUrl.includes('analytics') || embedUrl.includes('youtube.com')) continue;
    const serverInfo = serverMap[optId];
    const label = serverInfo ? serverInfo.name : `Server ${servers.length + 1}`;
    servers.push({ url: embedUrl, type: 'iframe', label });
  }

  console.log(`[depth=${_depth}] scrapeEpisodePlayer(${epUrl}) => ${servers.length} servers`);

  if (servers.length === 0 && _depth === 0) {
    const origNumMatch = epUrl.match(/(\d+)x(\d+)/);
    if (origNumMatch) {
      const origEpNum = parseInt(origNumMatch[2], 10);
      console.log(`  No servers found. Episode number: ${origEpNum}`);
      
      const dataUrlMatch = html.match(/data-url="(\/series\/([^/"]+)\/season\/\d+)"/);
      if (dataUrlMatch) {
        const realSeriesSlug = dataUrlMatch[2];
        console.log(`  Found real series: ${realSeriesSlug}`);

        const realSeriesHtml = (await fetchPage(`/series/${realSeriesSlug}/`)).html;
        if (realSeriesHtml) {
          const realSeasonUrls = [];
          const seasonAttrRegex = /data-url="([^"]+)"/gi;
          let sm;
          while ((sm = seasonAttrRegex.exec(realSeriesHtml)) !== null) {
            const u = sm[1];
            if (u.includes(`/series/${realSeriesSlug}/season/`) && !realSeasonUrls.includes(u)) realSeasonUrls.push(u);
          }
          realSeasonUrls.unshift(`/series/${realSeriesSlug}/`);
          console.log(`  Seasons to check:`, realSeasonUrls.slice(0, 5));

          for (const seasonUrl of realSeasonUrls) {
            const { html: seasonHtml } = await fetchPage(seasonUrl);
            if (!seasonHtml) continue;

            const epLinkGlobal = /href="([^"]*\/episode\/[^"]*-(\d+)x(\d+)\/)"/gi;
            let em;
            while ((em = epLinkGlobal.exec(seasonHtml)) !== null) {
              const epNum = parseInt(em[3], 10);
              if (epNum === origEpNum) {
                const realEpUrl = em[1].startsWith('http') ? em[1] : `${BASE_URL}${em[1]}`;
                console.log(`  ✅ Found matching episode: ${realEpUrl}`);
                return scrapeEpisodePlayer(realEpUrl, 1);
              }
            }
          }
          console.log(`  ❌ No matching episode found in ${realSeriesSlug}`);
        }
      } else {
        console.log(`  No data-url found in page HTML`);
      }
    }
  }

  return servers;
}

async function main() {
  console.log("Testing cross-series redirect for one-piece-2x62...\n");
  const sources = await scrapeEpisodePlayer('/episode/one-piece-2x62/');
  console.log("\nFinal sources:", sources.length);
  sources.forEach(s => console.log(" -", s.label, s.url));
  process.exit(0);
}

main();
