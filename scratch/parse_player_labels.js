const https = require('https');

https.get("https://toon-stream.site/episode/haikyu-multi-audio-1x1/", {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://toon-stream.site',
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    // Parse the server list: each li contains href="#options-N" and a <span class="server">NAME</span>
    const serverListRegex = /<li>([\s\S]*?)<\/li>/gi;
    let match;
    const serverMap = {}; // options-N -> real server name
    
    while ((match = serverListRegex.exec(body)) !== null) {
      const liHtml = match[1];
      const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
      const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
      const numMatch = liHtml.match(/<span>\s*(\d+)\s*<\/span>/);
      if (hrefMatch && nameMatch) {
        const optionId = hrefMatch[1];
        const serverName = nameMatch[1].trim();
        const serverNum = numMatch ? numMatch[1].trim() : '?';
        serverMap[optionId] = { name: serverName, num: serverNum };
      }
    }

    console.log("Server name map:", serverMap);

    // Now match options-N to embed URLs
    const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:src|data-src)="([^"]+)"/gi;
    const embedMap = {};
    while ((match = optionDivRegex.exec(body)) !== null) {
      embedMap[match[1]] = match[2];
    }
    console.log("Embed map:", embedMap);

    // Combine: for each options-N, map server name to embed URL
    console.log("\n=== Final Server → URL mapping ===");
    for (const [optId, embedUrl] of Object.entries(embedMap)) {
      const server = serverMap[optId];
      if (server) {
        console.log(`Server ${server.num} (${server.name}) → ${embedUrl}`);
      } else {
        console.log(`${optId} (unknown) → ${embedUrl}`);
      }
    }
  });
}).on('error', console.error);
