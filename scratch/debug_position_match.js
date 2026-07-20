// Test the actual toonstreamLive module's scrapeEpisodePlayer
// by temporarily exporting it
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
        timeout: 12000,
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
      req.on('error', () => { if (n > 0) setTimeout(() => attempt(n - 1), 1500); else resolve({ html: '', status: 500 }); });
      req.on('timeout', () => { req.destroy(); if (n > 0) setTimeout(() => attempt(n - 1), 1500); else resolve({ html: '', status: 504 }); });
    };
    attempt(retries);
  });
}

async function main() {
  // Step 1: Get position of one-piece-2x62 in /series/one-piece/season/2
  console.log("Step 1: Getting episode list of /series/one-piece/season/2...");
  const { html: s2Html } = await fetchPage('/series/one-piece/season/2');
  console.log("Season 2 HTML length:", s2Html.length);
  
  const allEpLinks = [];
  const allEpRegex = /href="([^"]*\/episode\/[^"]*-(\d+)x(\d+)\/)"/gi;
  let em;
  while ((em = allEpRegex.exec(s2Html)) !== null) {
    allEpLinks.push({ url: em[1], s: parseInt(em[2]), e: parseInt(em[3]) });
  }
  allEpLinks.sort((a, b) => a.e - b.e);
  console.log("Total season 2 episodes:", allEpLinks.length);
  console.log("First 5:", allEpLinks.slice(0, 5));
  
  const ep62pos = allEpLinks.findIndex(ep => ep.e === 62);
  console.log("Position of ep62:", ep62pos);
  
  // Step 2: Get episodes from /series/one-piece-wano-arc/ (main = season 1)
  console.log("\nStep 2: Getting Wano Arc main page episode list...");
  const { html: wanoHtml } = await fetchPage('/series/one-piece-wano-arc/');
  console.log("Wano Arc HTML length:", wanoHtml.length);
  
  const wanoEps = [];
  const wanoEpRegex = /href="([^"]*\/episode\/[^"]*-(\d+)x(\d+)\/)"/gi;
  while ((em = wanoEpRegex.exec(wanoHtml)) !== null) {
    wanoEps.push({ url: em[1], s: parseInt(em[2]), e: parseInt(em[3]) });
  }
  wanoEps.sort((a, b) => a.e - b.e);
  console.log("Total Wano Arc episodes on main page:", wanoEps.length);
  console.log("First 5:", wanoEps.slice(0, 5));
  
  // Step 3: Get episode at position ep62pos from Wano Arc
  if (ep62pos >= 0 && ep62pos < wanoEps.length) {
    const matched = wanoEps[ep62pos];
    console.log("\n✅ Matched episode:", matched);
  } else {
    console.log("\n❌ Position", ep62pos, "not in wano eps (", wanoEps.length, ")");
  }
  
  process.exit(0);
}

main();
