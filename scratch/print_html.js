const https = require('https');
const fs = require('fs');

function fetchPage(path) {
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
      res.on('end', () => resolve({ html: body }));
    }).on('error', (err) => resolve({ html: '' }));
  });
}

async function main() {
  const { html } = await fetchPage('/episode/one-piece-2x62/');
  fs.writeFileSync('scratch/ep62.html', html);
  console.log("Written HTML, length:", html.length);
  process.exit(0);
}

main();
