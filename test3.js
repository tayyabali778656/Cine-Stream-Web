const fs = require('fs');
const html = fs.readFileSync('temp_ep.html', 'utf8');
const dataUrlMatch = html.match(/data-url="\/series\/([^/"]+)\/season\/\d+"/);
console.log('Data URL Match:', dataUrlMatch ? dataUrlMatch[1] : 'none');
const titleMatch = html.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/i);
console.log('Title Match:', titleMatch ? titleMatch[1].trim() : 'none');
