const fs = require('fs');
let t = fs.readFileSync('serve.js', 'utf8');
t = t.replace(/(?<!in )Hindi Dubbed/gi, 'in Hindi Dubbed');
fs.writeFileSync('serve.js', t);
console.log('Done serve.js');

let s = fs.readFileSync('services/sitemapService.js', 'utf8');
s = s.replace(/(?<!in )Hindi Dubbed/gi, 'in Hindi Dubbed');
fs.writeFileSync('services/sitemapService.js', s);
console.log('Done sitemapService.js');
