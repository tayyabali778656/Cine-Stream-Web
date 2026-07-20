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
  // Let's check Season 5 first episode page: '/episode/one-piece-5x131/'
  const { html, status } = await fetchPage('/episode/one-piece-5x131/');
  console.log('Status of 5x131:', status);
  console.log('Has options?', html.includes('options-0'));
  
  // Let's see if there is any data-url for seasons/real series or what is in the HTML
  const dataUrlMatch = html.match(/data-url="([^"]+)"/g);
  console.log('Data URLs found:', dataUrlMatch);
  
  // Print first 1000 characters of the page if it has no player
  if (!html.includes('options-0')) {
    console.log('Snippet:', html.substring(0, 1000));
  }
}

main();
