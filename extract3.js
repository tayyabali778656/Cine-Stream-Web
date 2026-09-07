const fs = require('fs');
const html = fs.readFileSync('toon_series.html', 'utf8');
const match = html.match(/<article class="post dfx fcl episodes[^>]*>([\s\S]*?)<\/article>/i);
console.log(match ? match[1] : 'none');
