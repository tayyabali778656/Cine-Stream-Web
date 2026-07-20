const https = require('https');

function getUrl(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://watchanimeworld.net',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, status: res.statusCode }));
    }).on('error', (err) => resolve({ body: '', status: 500 }));
  });
}

async function main() {
  console.log("Fetching watchanimeworld one-piece main page...");
  const res = await getUrl('https://watchanimeworld.net/series/one-piece/');
  console.log("Status:", res.status);
  
  // Find all links containing "/episode/"
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let epMatch;
  console.log("=== Episode links found ===");
  let count = 0;
  while ((epMatch = epRegex.exec(res.body)) !== null && count < 20) {
    console.log(epMatch[1]);
    count++;
  }
  process.exit(0);
}

main();
