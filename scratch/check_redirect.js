const https = require('https');

function getHeaders(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://toon-stream.site',
      }
    }, (res) => {
      resolve({
        statusCode: res.statusCode,
        headers: res.headers
      });
    }).on('error', (err) => resolve({ statusCode: 500, headers: {} }));
  });
}

async function main() {
  console.log("Headers for /episode/one-piece-2x62/ :");
  const res = await getHeaders('/episode/one-piece-2x62/');
  console.log(res);
  process.exit(0);
}

main();
