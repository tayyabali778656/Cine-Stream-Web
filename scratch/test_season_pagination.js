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
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', (err) => resolve({ status: 500, body: '' }));
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
  const page2 = await getUrl("/series/one-piece/season/1/?page=2");
  const eps2 = parseEpisodes(page2.body);
  console.log("Page 2 status:", page2.status, "Eps found:", eps2.length);
  if (eps2.length > 0) {
    console.log("Page 2 eps:", eps2.map(e => e.episode).join(", "));
  }

  const page3 = await getUrl("/series/one-piece/season/1/?page=3");
  const eps3 = parseEpisodes(page3.body);
  console.log("Page 3 status:", page3.status, "Eps found:", eps3.length);
  if (eps3.length > 0) {
    console.log("Page 3 eps:", eps3.map(e => e.episode).join(", "));
  }
}

main();
