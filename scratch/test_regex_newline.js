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
  
  // Test the current regex: /data-url="\/series\/([^/"]+)\/season\/\d+"/
  // Note: the HTML output we saw has newline/whitespace inside the attribute or tags!
  // <a href="javascript:void(0)"
  //                class="season-btn "
  //                data-season="1"
  //                data-url="/series/one-piece-wano-arc/season/1">
  
  const testRegex = /data-url="\/series\/([^/"]+)\/season\/\d+"/;
  const match = html.match(testRegex);
  console.log('Direct test regex match:', match);
}

main();
