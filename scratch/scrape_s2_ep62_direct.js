const https = require('https');

function fetchPage(path) {
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
      res.on('end', () => resolve({ html: body }));
    }).on('error', (err) => resolve({ html: '' }));
  });
}

async function scrapeEpisodePlayer(epUrl) {
  try {
    const { html } = await fetchPage(epUrl);
    if (!html) return [];

    // Step 1: Parse the server selector list to build a map of options-N -> real server name
    const serverMap = {};
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
      const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
      const numMatch = liHtml.match(/<span>\s*(\d+)\s*<\/span>/);
      if (hrefMatch && nameMatch) {
        const optionId = hrefMatch[1];
        const serverName = nameMatch[1].trim();
        const serverNum = numMatch ? parseInt(numMatch[1].trim(), 10) : Object.keys(serverMap).length + 1;
        serverMap[optionId] = { name: serverName, num: serverNum };
      }
    }

    console.log("Parsed serverMap:", serverMap);

    // Step 2: Parse all option divs and map options-N -> embed URL
    const embedMap = {};
    const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:\bsrc\b|\bdata-src\b)="([^"]+)"/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `https://toon-stream.site${embedUrl}`;
      if (!embedMap[optMatch[1]]) {
        embedMap[optMatch[1]] = embedUrl;
      }
    }

    console.log("Parsed embedMap:", embedMap);

    // Step 3: Build final server list
    const servers = [];
    const optionIds = Object.keys(embedMap).sort((a, b) => {
      const na = parseInt(a.replace('options-', ''), 10);
      const nb = parseInt(b.replace('options-', ''), 10);
      return na - nb;
    });

    for (const optId of optionIds) {
      const embedUrl = embedMap[optId];
      if (
        embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
        embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
        embedUrl.includes('youtube.com')
      ) continue;

      const serverInfo = serverMap[optId];
      const label = serverInfo ? `${serverInfo.name}` : `Server ${servers.length + 1}`;
      servers.push({ url: embedUrl, type: 'iframe', label });
    }

    return servers;
  } catch (err) {
    return [];
  }
}

async function main() {
  console.log("Directly scraping S2E62 player sources...");
  const sources = await scrapeEpisodePlayer('/episode/one-piece-2x62/');
  console.log("Directly scraped sources:", sources);
  process.exit(0);
}

main();
