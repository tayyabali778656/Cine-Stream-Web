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
  const html = await getUrl("/series/one-piece");
  
  // Find any post-thumbnail or og:image or similar elements
  const postThumbnailMatch = html.match(/class="post-thumbnail[^"]*"[\s\S]*?<img[^>]+>/gi) || [];
  console.log("post-thumbnail img tag(s):", postThumbnailMatch);

  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
  console.log("og:image:", ogImageMatch ? ogImageMatch[1] : "not found");
}

main();
