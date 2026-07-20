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

async function main() {
  const html = await getUrl("/category/anime/?page=1");
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  let count = 0;
  while ((match = articleRegex.exec(html)) !== null && count < 5) {
    const artHtml = match[1];
    console.log(`=== Article ${count + 1} ===`);
    const imgMatches = artHtml.match(/<img[^>]+>/gi) || [];
    for (const img of imgMatches) {
      console.log(img);
    }
    count++;
  }
}

main();
