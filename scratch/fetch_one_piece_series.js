const https = require('https');

function getUrl(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://toon-stream.site',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', (err) => resolve(''));
  });
}

async function main() {
  console.log("Fetching /series/one-piece/ ...");
  const html = await getUrl('/series/one-piece/');
  
  // Find all season tabs/buttons
  const seasonRegex = /href="([^"]*\/series\/[^"]*)"/gi;
  let match;
  const seriesLinks = new Set();
  while ((match = seasonRegex.exec(html)) !== null) {
    if (match[1].includes('one-piece')) seriesLinks.add(match[1]);
  }
  console.log("=== Series/Season links on /series/one-piece/ ===");
  seriesLinks.forEach(l => console.log(l));
  
  // Find all episode links
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  const episodes = [];
  while ((match = epRegex.exec(html)) !== null) {
    episodes.push(match[1]);
  }
  console.log(`\n=== Episode links (total: ${episodes.length}) ===`);
  // Show first 10 and last 10
  episodes.slice(0, 10).forEach(e => console.log(e));
  console.log("...");
  episodes.slice(-10).forEach(e => console.log(e));
  
  // Find season selector buttons/tabs
  const tabRegex = /class="[^"]*tab[^"]*"[^>]*>([^<]*)/gi;
  const tabs = [];
  while ((match = tabRegex.exec(html)) !== null) {
    if (match[1].trim()) tabs.push(match[1].trim());
  }
  console.log("\n=== Tab labels ===");
  console.log(tabs.slice(0, 20));
  
  process.exit(0);
}

main();
