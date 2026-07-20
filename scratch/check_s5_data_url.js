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
  
  // Find all elements with class="season-btn" or similar to see what attributes they have
  const matches = html.match(/<[^>]+data-url="[^"]+"[^>]*>/gi) || [];
  console.log('Total elements with data-url attribute:', matches.length);
  
  // Print elements containing "/series/" in their data-url
  const seriesElements = matches.filter(el => el.includes('data-url="/series/'));
  console.log('Series data-url elements:');
  seriesElements.forEach(el => console.log(el));
}

main();
