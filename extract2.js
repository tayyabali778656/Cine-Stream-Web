const fs = require('fs');
const html = fs.readFileSync('toon_series.html', 'utf8');
const eps = Array.from(html.matchAll(/href="(\/episode\/one-piece-dub-sub-[^"]*)"/g)).map(m=>m[1]);
fs.writeFileSync('toon_eps.json', JSON.stringify(eps, null, 2));
