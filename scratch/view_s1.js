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
  const html = await getUrl("/series/one-piece/season/1");
  fs.writeFileSync("scratch/one_piece_season_1.html", html);
  console.log("Saved HTML to scratch/one_piece_season_1.html. Length:", html.length);
  
  // Find all instances of /episode/one-piece-
  const epRegex = /\/episode\/one-piece-[^\/"]+/gi;
  const matches = html.match(epRegex) || [];
  console.log("Total episode links on page:", matches.length);
  console.log("Unique links:", [...new Set(matches)].sort());
}

main();
