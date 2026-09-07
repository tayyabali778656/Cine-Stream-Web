const fs = require('fs');
const html = fs.readFileSync('temp_s21.html', 'utf8');
const match = html.match(/href="([^"]+21x892\/)"/);
console.log('Link in Season 21 HTML:', match ? match[1] : 'none');
