const fs = require('fs');
const html = fs.readFileSync('toon_user_url.html', 'utf8');
const liRegex = /<li>([\s\S]*?)<\/li>/gi;
let liMatch;
let servers = 0;
while ((liMatch = liRegex.exec(html)) !== null) {
  if (liMatch[1].includes('href="#options')) servers++;
}
console.log('Servers:', servers);
