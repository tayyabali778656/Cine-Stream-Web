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
  const res1 = await getUrl("/series/one-piece");
  console.log("One Piece series status:", res1.status);
  if (res1.status === 200) {
    const aTagRegex = /<a([\s\S]*?)>/gi;
    let aMatch;
    const seasonBtns = [];
    while ((aMatch = aTagRegex.exec(res1.body)) !== null) {
      const attrs = aMatch[1];
      if (attrs.includes('season-btn') || attrs.includes('season')) {
        seasonBtns.push(attrs);
      }
    }
    console.log("One Piece season buttons:", seasonBtns);
  }

  const res2 = await getUrl("/series/one-piece-multi-audio");
  console.log("One Piece Multi Audio status:", res2.status);

  // Let's search for one piece on the search URL
  const resSearch = await getUrl("/s?q=one+piece");
  console.log("Search 'one piece' status:", resSearch.status);
  
  // Find article titles and URLs in search results
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(resSearch.body)) !== null) {
    const artHtml = match[1];
    const titleMatch = artHtml.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/i) || artHtml.match(/alt="([^"]+)"/i);
    const hrefMatch = artHtml.match(/href="([^"]+)"/i);
    if (titleMatch && hrefMatch) {
      console.log(`Search result: Title: ${titleMatch[1].replace(/<[^>]*>/g, '').trim()} | Href: ${hrefMatch[1]}`);
    }
  }
}

main();
