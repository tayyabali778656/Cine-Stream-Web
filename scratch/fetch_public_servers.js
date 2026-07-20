const https = require('https');

function getJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Referer': 'https://toon-stream.site/episode/one-piece-2x62/',
        'X-Requested-With': 'XMLHttpRequest'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log("Status:", res.statusCode);
        console.log("Content-Type:", res.headers['content-type']);
        console.log("Body:", body.substring(0, 1000));
        resolve(body);
      });
    }).on('error', (err) => {
      console.log("Error:", err.message);
      resolve('');
    });
  });
}

async function main() {
  console.log("=== Fetching /public/servers ===");
  await getJson('https://toon-stream.site/public/servers');
  process.exit(0);
}

main();
