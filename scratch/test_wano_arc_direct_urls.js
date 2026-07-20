const https = require('https');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(path) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': BASE_URL,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchPage(res.headers.location));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode }));
    });
    req.on('error', () => resolve({ html: '', status: 500 }));
    req.on('timeout', () => { req.destroy(); resolve({ html: '', status: 504 }); });
  });
}

async function main() {
  // Test: does one-piece-wano-arc-2x62 exist and have a player?
  const tests = [
    '/episode/one-piece-wano-arc-2x62/',
    '/episode/one-piece-wano-arc-2x63/',
    '/episode/one-piece-wano-arc-3x77/',
  ];
  
  for (const url of tests) {
    const { html, status } = await fetchPage(url);
    const hasOptions = html.includes('options-0') || html.includes('options-1');
    const iframeCount = (html.match(/id="options-\d+"/gi) || []).length;
    console.log(`${url} | status=${status} | length=${html.length} | hasOptions=${hasOptions} | iframes=${iframeCount}`);
    if (html.length > 0 && html.length < 1000) {
      console.log("Short response:", html.substring(0, 500));
    }
  }
  
  process.exit(0);
}

main();
