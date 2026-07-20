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
  
  // Let's print the actual match of testRegex with a broad match
  const testRegex = /data-url="\/series\/([^/"]+)\/season\/\d+"/;
  const match = testRegex.exec(html);
  
  console.log('Result type:', typeof match);
  if (match) {
    console.log('Match details:', match[0], 'Group 1:', match[1]);
  } else {
    // Let's look for whitespace in HTML near data-url attribute
    const index = html.indexOf('data-url="/series/');
    if (index !== -1) {
      console.log('Surrounding HTML:', html.substring(index - 100, index + 100));
    }
  }
}

main();
