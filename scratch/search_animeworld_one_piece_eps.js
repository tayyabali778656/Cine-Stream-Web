const https = require('https');

function getUrl(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://watchanimeworld.net',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, status: res.statusCode }));
    }).on('error', (err) => resolve({ body: '', status: 500 }));
  });
}

async function main() {
  console.log("Fetching watchanimeworld one-piece main page...");
  const res = await getUrl('https://watchanimeworld.net/series/one-piece/');
  
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let epMatch;
  const list = [];
  while ((epMatch = epRegex.exec(res.body)) !== null) {
    list.push(epMatch[1]);
  }
  
  console.log("Total episode links found on page:", list.length);
  // Log all links containing "2x" or "one-piece-2"
  const s2links = list.filter(l => l.includes('one-piece-2x') || l.includes('one-piece-2-'));
  console.log("=== Season 2 links found ===");
  console.log(s2links);
  
  // Log some general samples from the middle/end
  console.log("=== Sample links ===");
  console.log(list.slice(0, 5));
  console.log(list.slice(Math.floor(list.length/2), Math.floor(list.length/2) + 5));
  console.log(list.slice(-5));
  process.exit(0);
}

main();
