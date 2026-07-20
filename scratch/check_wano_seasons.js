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
      console.log('Status:', res.statusCode, 'Location:', res.headers.location || 'none');
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchPage(res.headers.location));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode }));
    });
    req.on('error', (err) => { console.log('Error:', err.message); resolve({ html: '', status: 500 }); });
    req.on('timeout', () => { req.destroy(); resolve({ html: '', status: 504 }); });
  });
}

async function main() {
  // Check what happens at wano-arc season 21 - get episode list
  console.log("=== /series/one-piece-wano-arc/season/21 ===");
  const { html, status } = await fetchPage('/series/one-piece-wano-arc/season/21');
  console.log("Status:", status, "Length:", html.length);
  
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let m;
  const eps = [];
  while ((m = epRegex.exec(html)) !== null) eps.push(m[1]);
  console.log("Episodes:", eps.length);
  eps.slice(0, 5).forEach(e => console.log(e));
  eps.slice(-3).forEach(e => console.log(e));
  
  console.log("\n=== /series/one-piece-wano-arc/season/22 ===");
  const { html: h22 } = await fetchPage('/series/one-piece-wano-arc/season/22');
  const eps22 = [];
  while ((m = epRegex.exec(h22)) !== null) eps22.push(m[1]);
  console.log("Episodes:", eps22.length);
  eps22.slice(0, 5).forEach(e => console.log(e));
  eps22.slice(-3).forEach(e => console.log(e));
  
  process.exit(0);
}

main();
