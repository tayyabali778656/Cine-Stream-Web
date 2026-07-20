const https = require('https');

function getUrl(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
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

function countEpisodes(html) {
  const epRegex = /href="([^"]*\/episode\/[^"]*)"/gi;
  let m;
  let count = 0;
  while ((m = epRegex.exec(html)) !== null) count++;
  return count;
}

async function main() {
  // Check which seasons of /series/one-piece/ actually have episodes
  const mainHtml = (await getUrl('/series/one-piece/')).body;
  
  // Extract all season data-urls
  const seasonRegex = /class="season-btn[^"]*"\s+data-season="(\d+)"\s+data-url="([^"]+)"/gi;
  let m;
  const seasons = [];
  while ((m = seasonRegex.exec(mainHtml)) !== null) {
    seasons.push({ num: parseInt(m[1]), url: m[2] });
  }
  
  console.log("Total seasons found:", seasons.length);
  console.log("Season list:", seasons.map(s => `Season ${s.num}`).join(', '));
  
  // Check a sample of seasons to see which have actual episodes with sources
  console.log("\n=== Checking episode quality per season ===");
  for (const s of seasons.slice(0, 5)) {
    const { body } = await getUrl(s.url);
    const epCount = countEpisodes(body);
    
    // Get first episode and check if it has options-
    const firstEpMatch = body.match(/href="([^"]*\/episode\/[^"]*)"/i);
    let hasPlayer = false;
    if (firstEpMatch) {
      const { body: epBody } = await getUrl(firstEpMatch[1]);
      hasPlayer = epBody.includes('options-0') || epBody.includes('options-1');
    }
    
    console.log(`Season ${s.num} (${s.url}): ${epCount} eps | first ep has player: ${hasPlayer}`);
  }
  
  process.exit(0);
}

main();
