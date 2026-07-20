const https = require('https');

function getUrl(url, referer) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': referer || 'https://toon-stream.site/series/one-piece/',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, status: res.statusCode, headers: res.headers }));
    });
    req.on('error', (err) => resolve({ body: '', status: 500, headers: {} }));
  });
}

async function main() {
  // Try the season/2 URL
  console.log("=== Fetching /series/one-piece/season/2 ===");
  const r1 = await getUrl('https://toon-stream.site/series/one-piece/season/2', 'https://toon-stream.site/series/one-piece/');
  console.log("Status:", r1.status);
  console.log("Content-Type:", r1.headers['content-type']);
  console.log("Body length:", r1.body.length);
  
  // Check for episode links
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let match;
  const eps = [];
  while ((match = epRegex.exec(r1.body)) !== null) eps.push(match[1]);
  console.log("Episode links found:", eps.length);
  eps.slice(0, 5).forEach(e => console.log(e));
  eps.slice(-5).forEach(e => console.log(e));
  
  // Also try JSON format  
  console.log("\n=== Fetching with JSON accept ===");
  const r2 = await getUrl('https://toon-stream.site/series/one-piece/season/2', 'https://toon-stream.site/series/one-piece/');
  console.log("Body start:", r2.body.substring(0, 200));
  
  process.exit(0);
}

main();
