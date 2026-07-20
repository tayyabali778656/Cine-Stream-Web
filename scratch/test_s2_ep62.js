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
      res.on('end', () => resolve({ body, status: res.statusCode }));
    }).on('error', (err) => resolve({ body: '', status: 500 }));
  });
}

async function main() {
  console.log("Fetching Season 2 Episode 62...");
  const res = await getUrl('/episode/one-piece-2x62/');
  console.log("Status:", res.status);
  console.log("Body length:", res.body.length);
  console.log("Contains canonical home?", res.body.includes('canonical" href="/home"'));
  console.log("Contains options-?", res.body.includes('options-'));
  console.log("Contains server?", res.body.includes('server'));
  process.exit(0);
}

main();
