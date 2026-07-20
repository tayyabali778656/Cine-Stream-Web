const https = require('https');
const fs = require('fs');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(path) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': BASE_URL,
      },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchPage(res.headers.location));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode }));
    });
    req.on('error', () => resolve({ html: '', status: 500 }));
    req.on('timeout', () => { req.destroy(); resolve({ html: '', status: 504 }); });
  });
}

async function main() {
  // First, get the first episode of Season 3 from /series/one-piece/season/3
  console.log("=== Getting Season 3 episode list ===");
  const { html: s3Html } = await fetchPage('/series/one-piece/season/3');
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let m;
  const s3eps = [];
  while ((m = epRegex.exec(s3Html)) !== null) s3eps.push(m[1]);
  s3eps.sort();
  console.log("Total S3 eps:", s3eps.length);
  console.log("First:", s3eps[0]);
  
  if (s3eps.length === 0) {
    process.exit(0);
  }
  
  // Fetch the first S3 episode page
  console.log("\n=== Fetching first S3 episode page:", s3eps[0], "===");
  const { html: epHtml } = await fetchPage(s3eps[0]);
  
  // Check if it has a player
  console.log("Has options-?", epHtml.includes('options-0'));
  
  // Find ALL episode links in this page (sidebar)
  const allEpLinks = new Set();
  while ((m = epRegex.exec(epHtml)) !== null) {
    allEpLinks.add(m[1]);
  }
  console.log("In-page episode links count:", allEpLinks.size);
  const epArr = [...allEpLinks];
  console.log("First 5:", epArr.slice(0, 5));
  console.log("Last 3:", epArr.slice(-3));
  
  // Check the data-url attributes
  const dataUrlRegex = /data-url="([^"]+)"/gi;
  const dataUrls = [];
  while ((m = dataUrlRegex.exec(epHtml)) !== null) {
    dataUrls.push(m[1]);
  }
  console.log("data-url attributes:", dataUrls.slice(0, 5));
  
  process.exit(0);
}

main();
