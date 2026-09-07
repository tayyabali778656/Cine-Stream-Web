const fs = require('fs');
const html = fs.readFileSync('wano.html', 'utf8');
const eps = Array.from(html.matchAll(/href="(\/episode\/one-piece-wano-arc-[^"]*)"/g)).map(m=>m[1]);
fs.writeFileSync('wano_eps.json', JSON.stringify(eps, null, 2));
