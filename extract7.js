const fs = require('fs');
const html = fs.readFileSync('toon_21x892.html', 'utf8');
const servers = Array.from(html.matchAll(/data-id="([^"]+)"([^>]*)>([^<]+)<\/a>/gi)).map(m => m[3].trim());
console.log(servers);
