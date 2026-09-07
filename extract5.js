const fs = require('fs');
const html = fs.readFileSync('toon_series.html', 'utf8');
const seasons = Array.from(html.matchAll(/season-btn[^>]*data-url="([^"]*)"/g)).map(m=>m[1]);
console.log(seasons);
