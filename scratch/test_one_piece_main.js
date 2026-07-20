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
      res.on('end', () => {
        resolve({ status: res.statusCode, body });
      });
    }).on('error', (err) => resolve({ status: 500, error: err }));
  });
}

async function main() {
  const res = await getUrl("/series/one-piece");
  console.log("One Piece status:", res.status);
  
  // Parse episodes from main page HTML
  const list = [];
  const epArticleRegex = /<article class="post dfx fcl episodes[^"]*">([\s\S]*?)<\/article>/gi;
  let epMatch;
  while ((epMatch = epArticleRegex.exec(res.body)) !== null) {
    const epHtml = epMatch[1];
    const urlMatch = epHtml.match(/href=["']([^"']+)["']/);
    if (!urlMatch) continue;
    const epUrl = urlMatch[1];
    const numMatch = epUrl.match(/(\d+)x(\d+)/);
    if (numMatch) {
      list.push({ season: parseInt(numMatch[1], 10), episode: parseInt(numMatch[2], 10) });
    }
  }
  console.log("Episodes found on main page:", list.length);
  if (list.length > 0) {
    console.log("First episode:", list[0]);
    console.log("Last episode:", list[list.length - 1]);
    console.log("Seasons on main page:", [...new Set(list.map(e => e.season))]);
  }
}

main();
