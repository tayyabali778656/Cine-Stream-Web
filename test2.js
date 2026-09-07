const html = require('fs').readFileSync('temp_animekai_ep1.html', 'utf8');

const titleMatch = html.match(/<h2 class="title"[^>]*>([^<]+)<\/h2>/i) || html.match(/<h1 class="title"[^>]*>([^<]+)<\/h1>/i);
const posterMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
const descMatch = html.match(/<div class="desc text-expand"[^>]*>([\s\S]*?)(?:<\/div>|<!--)/i);
const dateMatch = html.match(/Date aired: <span>\s*([\s\S]*?)\s*<\/span>/i);

console.log('Title:', titleMatch ? titleMatch[1].trim() : 'null');
console.log('Poster:', posterMatch ? posterMatch[1].trim() : 'null');
console.log('Desc:', descMatch ? descMatch[1].trim() : 'null');
console.log('Year:', dateMatch ? dateMatch[1].trim() : 'null');
