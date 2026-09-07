const html = require('fs').readFileSync('temp_animekai_ep1.html', 'utf8');
console.log('Title:', html.match(/<h1 class="title"[^>]*>([^<]+)<\/h1>/)?.[1]);
console.log('Desc:', html.match(/<div class="description"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
console.log('Poster:', html.match(/<div class="poster">\s*<img src="([^"]+)"/)?.[1]);
console.log('Year:', html.match(/Release Date:[^>]*>\s*(\d{4})/i)?.[1]);
