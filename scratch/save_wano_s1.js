const https = require('https');
const fs = require('fs');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(url) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve) => {
    https.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*',
        'Referer': BASE_URL,
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode }));
    }).on('error', () => resolve({ html: '', status: 500 }));
  });
}

async function main() {
  const { html } = await fetchPage('/series/one-piece-wano-arc/season/1');
  fs.writeFileSync('scratch/wano_s1.html', html, 'utf8');
  console.log("Saved wano_s1.html, length:", html.length);
  
  // Find ALL episode hrefs
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let m;
  const eps = [];
  while ((m = epRegex.exec(html)) !== null) eps.push(m[1]);
  console.log("All episode links:", eps.length);
  eps.slice(0, 10).forEach(e => console.log(e));
  eps.slice(-5).forEach(e => console.log(e));
  
  process.exit(0);
}

main();
