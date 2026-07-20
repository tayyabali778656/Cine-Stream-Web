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
  console.log("Searching ToonStream for 'one piece'...");
  const html = await getUrl('/?s=one+piece');
  
  // Find all article or series links containing "one-piece"
  const regex = /href="([^"]*\/series\/[^"]*)"/gi;
  let match;
  console.log("=== Series found on ToonStream ===");
  const found = new Set();
  while ((match = regex.exec(html)) !== null) {
    found.add(match[1]);
  }
  found.forEach(url => console.log(url));
  process.exit(0);
}

main();
