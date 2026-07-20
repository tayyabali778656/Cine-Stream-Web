const https = require('https');

function getUrl(path) {
  return new Promise((resolve) => {
    https.get(`https://toon-stream.site${path}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://toon-stream.site',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    }).on('error', (err) => resolve(''));
  });
}

function parseEpisodes(html) {
  const list = [];
  const epArticleRegex = /<article class="post dfx fcl episodes[^"]*">([\s\S]*?)<\/article>/gi;
  let epMatch;
  while ((epMatch = epArticleRegex.exec(html)) !== null) {
    const epHtml = epMatch[1];
    const urlMatch = epHtml.match(/href=["']([^"']+)["']/);
    if (!urlMatch) continue;
    const epUrl = urlMatch[1];
    const numMatch = epUrl.match(/(\d+)x(\d+)/);
    if (numMatch) {
      list.push({ season: parseInt(numMatch[1], 10), episode: parseInt(numMatch[2], 10) });
    }
  }
  return list;
}

async function main() {
  for (let s = 1; s <= 5; s++) {
    const html = await getUrl(`/series/one-piece/season/${s}`);
    const eps = parseEpisodes(html);
    eps.sort((a,b) => a.episode - b.episode);
    console.log(`Season ${s}: found ${eps.length} episodes. Range: ${eps[0]?.episode} to ${eps[eps.length-1]?.episode}`);
  }
}

main();
