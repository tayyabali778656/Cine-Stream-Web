const https = require('https');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(url) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve) => {
    https.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': BASE_URL,
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode }));
    }).on('error', () => resolve({ html: '', status: 500 }));
  });
}

async function main() {
  const { html } = await fetchPage('/episode/one-piece-5x131/');
  
  // Let's find all episode links in this page to see if they are still wano-arc-1x...
  const epRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
  let m;
  const inPageEps = [];
  while ((m = epRegex.exec(html)) !== null) {
    inPageEps.push(m[1]);
  }
  
  console.log('Total in-page episodes:', inPageEps.length);
  console.log('First 5 in-page episodes:', inPageEps.slice(0, 5));
  console.log('Last 5 in-page episodes:', inPageEps.slice(-5));
}

main();
