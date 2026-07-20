const https = require('https');
const fs = require('fs');

function getUrl(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://toon-stream.site',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, status: res.statusCode }));
    }).on('error', (err) => resolve({ body: '', status: 500 }));
  });
}

async function main() {
  // Fetch Wano Arc season 1 episode list
  console.log("=== Fetching /series/one-piece-wano-arc/season/1 ===");
  const { body } = await getUrl('/series/one-piece-wano-arc/season/1');
  console.log("Body length:", body.length);
  
  // Extract episode links
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let m;
  const eps = [];
  while ((m = epRegex.exec(body)) !== null) eps.push(m[1]);
  console.log("Episode links:", eps.length);
  eps.slice(0, 5).forEach(e => console.log(e));
  eps.slice(-3).forEach(e => console.log(e));
  
  // Now fetch first episode page
  if (eps.length > 0) {
    console.log("\n=== Fetching first Wano Arc episode:", eps[0], "===");
    const { body: epBody } = await getUrl(eps[0]);
    
    // Check for options-
    const hasOptions = epBody.includes('options-');
    console.log("Contains options-?", hasOptions);
    
    // Check for iframes
    const iframeRegex = /<iframe[^>]*src="([^"]+)"/gi;
    while ((m = iframeRegex.exec(epBody)) !== null) {
      console.log("iframe src:", m[1]);
    }
    
    // Check for data-src
    const dsRegex = /data-src="([^"]+)"/gi;
    while ((m = dsRegex.exec(epBody)) !== null) {
      console.log("data-src:", m[1]);
    }
    
    // Check for li elements with href starting with # (server options)
    const liRegex = /<li[^>]*>[\s\S]*?href="#options-(\d+)"[\s\S]*?<\/li>/gi;
    let count = 0;
    while ((m = liRegex.exec(epBody)) !== null && count < 5) {
      console.log("Server li:", m[0].substring(0, 200));
      count++;
    }
    
    // Also check for 'href="#' pattern
    const hrefHashRegex = /href="#options-\d+"/gi;
    while ((m = hrefHashRegex.exec(epBody)) !== null) {
      console.log("href hash:", m[0]);
    }
  }
  
  process.exit(0);
}

main();
