const fs = require('fs');
const html = fs.readFileSync('toon_user_url.html', 'utf8');
const embedMap = {};
const optionDivRegex = /id=["']?(options-\d+)["']?[\s\S]*?(?:\bsrc\b|\bdata-src\b)=["']([^"']+)["']/gi;
let optMatch;
while ((optMatch = optionDivRegex.exec(html)) !== null) {
  embedMap[optMatch[1]] = optMatch[2];
}
Object.values(embedMap).forEach(url => console.log(url));
