const https = require('https');
const fs = require('fs');

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
  const html = await getUrl('/series/one-piece/');
  fs.writeFileSync('scratch/one-piece-series.html', html, 'utf8');
  console.log("Saved to scratch/one-piece-series.html, length:", html.length);
  
  // Check for season 2 or page 2 links
  const s2 = html.match(/season.?2|page=2|\?page|\/2\//gi);
  console.log("Season/page 2 mentions:", s2 ? [...new Set(s2)] : 'none');
  
  // Check for pagination
  const pageRegex = /href="([^"]*one-piece[^"]*(?:page|season)[^"]*)"/gi;
  let match;
  while ((match = pageRegex.exec(html)) !== null) {
    console.log("Pagination/season link:", match[1]);
  }
  
  process.exit(0);
}

main();
