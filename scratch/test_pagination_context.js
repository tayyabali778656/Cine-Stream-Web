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
  const html = await getUrl("/series/one-piece");
  const idx = html.indexOf('pagination');
  if (idx !== -1) {
    console.log("=== pagination ===");
    console.log(html.substring(idx - 200, idx + 800));
  }
  const idx2 = html.indexOf('navigation');
  if (idx2 !== -1) {
    console.log("=== navigation ===");
    console.log(html.substring(idx2 - 200, idx2 + 800));
  }
  const idx3 = html.indexOf('page-numbers');
  if (idx3 !== -1) {
    console.log("=== page-numbers ===");
    console.log(html.substring(idx3 - 200, idx3 + 800));
  }
}

main();
