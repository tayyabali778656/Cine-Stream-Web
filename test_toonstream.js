const https = require('https');

const BASE_URL = 'https://toon-stream.site';

function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 404) { resolve({ html: '', status: 404 }); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', reject);
      }).on('error', (err) => {
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else reject(err);
      });
    };
    attempt(retries);
  });
}

async function scrapeEpisodePlayer(epUrl) {
  try {
    const { html, status } = await fetchPage(epUrl);
    console.log("Status:", status);
    console.log("HTML length:", html.length);
    if (!html || status === 404) return [];

    const serverMap = {}; 
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
      const spans = [...liHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map(m => m[1].trim());
      let serverName = 'Server';
      let serverNumMatch = null;
      if (spans.length >= 2) {
        serverNumMatch = spans[0];
        serverName = spans[1];
      } else if (spans.length === 1) {
        if (!isNaN(parseInt(spans[0]))) { serverNumMatch = spans[0]; } else { serverName = spans[0]; }
      }
      const classMatch = liHtml.match(/<span[^>]*class=["']server["'][^>]*>([\s\S]*?)<\/span>/i);
      if (classMatch) { serverName = classMatch[1].trim(); }

      if (hrefMatch) {
        const optionId = hrefMatch[1];
        if (!isNaN(serverName) || serverName === '') { serverName = 'Server'; }
        const serverNum = serverNumMatch ? parseInt(serverNumMatch, 10) : Object.keys(serverMap).length + 1;
        serverMap[optionId] = { name: serverName, num: serverNum };
      }
    }

    const embedMap = {}; 
    const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:\bsrc\b|\bdata-src\b)="([^"]+)"/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `${BASE_URL}${embedUrl}`;
      if (!embedMap[optMatch[1]]) { embedMap[optMatch[1]] = embedUrl; }
    }

    console.log("Server Map:", serverMap);
    console.log("Embed Map:", embedMap);

    const servers = [];
    const optionIds = Object.keys(embedMap);
    for (const optId of optionIds) {
      const embedUrl = embedMap[optId];
      const serverInfo = serverMap[optId];
      const label = serverInfo ? `${serverInfo.name}` : `Server ${servers.length + 1}`; 
      servers.push({ url: embedUrl, type: 'iframe', label });
    }

    return servers;
  } catch (err) {
    console.error(err);
    return [];
  }
}

scrapeEpisodePlayer('/episode/dandadan-episode-1/').then(console.log);
