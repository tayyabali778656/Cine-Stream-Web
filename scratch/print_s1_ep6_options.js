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
  const html = await getUrl('/episode/one-piece-1x6/');
  const idx = html.indexOf('options-');
  if (idx !== -1) {
    console.log("Snippet from Season 1 Episode 6:");
    console.log(html.substring(idx - 100, idx + 800));
  } else {
    console.log("options- not found in Season 1 Episode 6");
  }
  process.exit(0);
}

main();
