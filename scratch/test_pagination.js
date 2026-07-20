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
  const html = await getUrl("/series/one-piece/season/1");
  
  // Find any pagination / page / navigations / page-numbers
  console.log("Has pagination:", html.includes("pagination") || html.includes("page-numbers") || html.includes("navigation"));
  
  // Let's print occurrences of 'page/' or 'page=' or similar navigation elements
  const pageRegex = /href="([^"]*?\/page\/\d+[^"]*?)"/gi;
  let match;
  const pageLinks = [];
  while ((match = pageRegex.exec(html)) !== null) {
    pageLinks.push(match[1]);
  }
  console.log("Page links found:", [...new Set(pageLinks)]);

  // Let's check if there is next page or pagination elements in html
  const idx = html.indexOf('pagination');
  if (idx !== -1) {
    console.log("Context around 'pagination':", html.substring(idx - 100, idx + 500));
  } else {
    const idx2 = html.indexOf('navigation');
    if (idx2 !== -1) {
      console.log("Context around 'navigation':", html.substring(idx2 - 100, idx2 + 500));
    }
  }
}

main();
