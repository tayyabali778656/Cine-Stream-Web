const https = require('https');

function getUrl(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://toon-stream.site',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, status: res.statusCode }));
    }).on('error', (err) => resolve({ body: '', status: 500 }));
  });
}

async function main() {
  // Season 2 = one-piece/season/2 → episodes: one-piece-2x62..
  // These ep pages show "One Piece Wano Arc" and link to one-piece-wano-arc series
  // But the one-piece-wano-arc series has episodes: one-piece-wano-arc-1x1..
  
  // Verify: fetch the ep page for one-piece-2x62 and extract the series link
  const { body } = await getUrl('/episode/one-piece-2x62/');
  
  // Find the series link (breadcrumb or series button)
  const seriesLinkRegex = /href="([^"]*\/series\/[^"]*)"[^>]*>/gi;
  let m;
  const seriesLinks = new Set();
  while ((m = seriesLinkRegex.exec(body)) !== null) {
    seriesLinks.add(m[1]);
  }
  console.log("=== Series links on one-piece-2x62 page ===");
  seriesLinks.forEach(l => console.log(l));
  
  // Find the data-url attributes (for season buttons)
  const dataUrlRegex = /data-url="([^"]+)"/gi;
  const dataUrls = new Set();
  while ((m = dataUrlRegex.exec(body)) !== null) {
    dataUrls.add(m[1]);
  }
  console.log("\n=== data-url attributes on one-piece-2x62 page ===");
  dataUrls.forEach(u => console.log(u));
  
  process.exit(0);
}

main();
