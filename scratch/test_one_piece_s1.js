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
      resolve(res.statusCode);
    }).on('error', (err) => resolve(500));
  });
}

async function main() {
  for (let i = 1; i <= 10; i++) {
    const status = await getUrl(`/episode/one-piece-1x${i}/`);
    console.log(`Episode 1x${i} status:`, status);
  }
}

main();
