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
  
  // Step 1: Collect inPageEps
  const inPageEpRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
  let em;
  const inPageEps = [];
  while ((em = inPageEpRegex.exec(html)) !== null) {
    inPageEps.push(em[1]);
  }
  
  const origSlug = 'one-piece';
  const origSeason = 5;
  const origEpNum = 131;
  
  // Step 2: Compute cumulative pos
  let cumulativePos = 0;
  let foundInSeason = false;

  for (let s = 2; s <= origSeason; s++) {
    const { html: sHtml } = await fetchPage(`/series/${origSlug}/season/${s}`);
    if (!sHtml) {
      console.log(`Failed to fetch season ${s}`);
      continue;
    }

    const sEpRegex = /href="([^"]*\/episode\/[^"]*-(\d+)x(\d+)\/)"/gi;
    const sEps = [];
    while ((em = sEpRegex.exec(sHtml)) !== null) {
      sEps.push({ e: parseInt(em[3], 10) });
    }
    sEps.sort((a, b) => a.e - b.e);
    
    console.log(`Season ${s} total episodes:`, sEps.length);

    if (s === origSeason) {
      const posInSeason = sEps.findIndex(ep => ep.e === origEpNum);
      if (posInSeason >= 0) {
        cumulativePos += posInSeason;
        foundInSeason = true;
      }
      console.log(`Pos of ${origEpNum} in season ${s}:`, posInSeason);
      break;
    } else {
      cumulativePos += sEps.length;
    }
  }
  
  console.log('Found in season?', foundInSeason);
  console.log('Cumulative position computed:', cumulativePos);
  console.log('Total in-page episodes:', inPageEps.length);
  
  if (foundInSeason && cumulativePos < inPageEps.length) {
    console.log('Matched target URL:', inPageEps[cumulativePos]);
  } else {
    console.log('Out of bounds or not found!');
  }
}

main();
