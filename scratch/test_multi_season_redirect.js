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
  
  // Find all season URLs for the real series from season-btn elements
  // <a href="javascript:void(0)" class="season-btn" data-url="/series/one-piece-wano-arc/season/21">
  const seasonBtnRegex = /data-url="(\/series\/[^/"]+\/season\/\d+)"/gi;
  let sm;
  const seasonUrls = [];
  while ((sm = seasonBtnRegex.exec(html)) !== null) {
    if (!seasonUrls.includes(sm[1])) {
      seasonUrls.push(sm[1]);
    }
  }
  
  console.log('Real series season URLs found on page:', seasonUrls);
  
  // Collect episodes from initial page first (this is season 1)
  const inPageEpRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
  let em;
  const allRealEps = [];
  const seenEps = new Set();
  while ((em = inPageEpRegex.exec(html)) !== null) {
    const epUrl = em[1];
    if (!seenEps.has(epUrl)) {
      seenEps.add(epUrl);
      allRealEps.push(epUrl);
    }
  }
  console.log('Season 1 episodes:', allRealEps.length);
  
  // Now fetch other seasons and add them
  for (const sUrl of seasonUrls) {
    const { html: sHtml } = await fetchPage(sUrl);
    const sEpRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
    let count = 0;
    while ((em = sEpRegex.exec(sHtml)) !== null) {
      const epUrl = em[1];
      if (!seenEps.has(epUrl)) {
        seenEps.add(epUrl);
        allRealEps.push(epUrl);
        count++;
      }
    }
    console.log(`Added from ${sUrl}:`, count);
  }
  
  console.log('Total cumulative real episodes:', allRealEps.length);
  
  const targetPos = 69; // Cumulative pos computed in trace_s5.js
  if (targetPos < allRealEps.length) {
    console.log(`✅ Success! Ep at index ${targetPos} is:`, allRealEps[targetPos]);
  } else {
    console.log('❌ targetPos still out of bounds!');
  }
}

main();
