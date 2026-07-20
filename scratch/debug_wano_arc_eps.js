const https = require('https');

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
  // Check what episodes are in Wano Arc season 1 (the main page, which is actually season 1)
  console.log("=== Wano Arc main page episodes ===");
  const { html: mainHtml } = await fetchPage('/series/one-piece-wano-arc/');
  const epLinkGlobal = /href="([^"]*\/episode\/one-piece-wano-arc-(\d+)x(\d+)\/)" /gi;
  let em;
  const eps = [];
  while ((em = epLinkGlobal.exec(mainHtml)) !== null) {
    eps.push({ url: em[1], s: parseInt(em[2]), e: parseInt(em[3]) });
  }
  console.log("Count:", eps.length);
  eps.slice(0, 5).forEach(e => console.log(e));
  eps.slice(-3).forEach(e => console.log(e));
  
  // Also check season 1 via season URL
  console.log("\n=== Wano Arc /season/1 episodes ===");
  const { html: s1Html } = await fetchPage('/series/one-piece-wano-arc/season/1');
  const eps2 = [];
  const epLinkGlobal2 = /href="([^"]*\/episode\/one-piece-wano-arc-(\d+)x(\d+)\/)" /gi;
  while ((em = epLinkGlobal2.exec(s1Html)) !== null) {
    eps2.push({ url: em[1], s: parseInt(em[2]), e: parseInt(em[3]) });
  }
  console.log("Count:", eps2.length);
  eps2.slice(0, 5).forEach(e => console.log(e));
  
  // Now check: does episode 62 exist in either?
  console.log("\n=== Looking for ep 62 in both ===");
  const found1 = eps.find(e => e.e === 62);
  const found2 = eps2.find(e => e.e === 62);
  console.log("Main page ep62:", found1);
  console.log("Season/1 ep62:", found2);
  
  process.exit(0);
}

main();
