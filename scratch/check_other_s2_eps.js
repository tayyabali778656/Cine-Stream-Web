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
  console.log("Checking S2E63...");
  const html63 = await getUrl('/episode/one-piece-2x63/');
  console.log("S2E63 length:", html63.length);
  console.log("S2E63 contains options-?", html63.includes('options-'));
  
  console.log("Checking S2E65...");
  const html65 = await getUrl('/episode/one-piece-2x65/');
  console.log("S2E65 length:", html65.length);
  console.log("S2E65 contains options-?", html65.includes('options-'));
  
  process.exit(0);
}

main();
