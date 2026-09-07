const fs = require('fs');

async function test() {
  const html = fs.readFileSync('toon_21x892.html', 'utf8');

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
      if (!isNaN(parseInt(spans[0]))) {
        serverNumMatch = spans[0];
      } else {
        serverName = spans[0];
      }
    }
    
    const classMatch = liHtml.match(/<span[^>]*class=["']server["'][^>]*>([\s\S]*?)<\/span>/i);
    if (classMatch) {
      serverName = classMatch[1].trim();
    }

    if (hrefMatch) {
      const optionId = hrefMatch[1];
      if (!isNaN(serverName) || serverName === '') {
        serverName = 'Server';
      }
      const serverNum = serverNumMatch ? parseInt(serverNumMatch, 10) : Object.keys(serverMap).length + 1;
      serverMap[optionId] = { name: serverName, num: serverNum };
    }
  }
  
  const embedMap = {};
  const optionDivRegex = /id=["']?(options-\d+)["']?[\s\S]*?(?:\bsrc\b|\bdata-src\b)=["']([^"']+)["']/gi;
  let optMatch;
  while ((optMatch = optionDivRegex.exec(html)) !== null) {
    let embedUrl = optMatch[2];
    if (!embedMap[optMatch[1]]) {
      embedMap[optMatch[1]] = embedUrl;
    }
  }

  console.log('serverMap:', serverMap);
  console.log('embedMap:', embedMap);
}
test();
