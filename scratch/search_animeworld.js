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
  const url = 'https://watchanimeworld.net/?s=one+piece';
  console.log("Searching watchanimeworld for one piece...");
  const res = await getUrl(url);
  console.log("Status:", res.status);
  
  // Find all links matching /series/ or containing "one-piece"
  const regex = /href="([^"]*\/series\/[^"]*)"/gi;
  let match;
  console.log("=== Series links found ===");
  while ((match = regex.exec(res.body)) !== null) {
    console.log(match[1]);
  }
  process.exit(0);
}

main();
