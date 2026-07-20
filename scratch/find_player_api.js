const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find all script src tags
const scriptSrcRegex = /<script[^>]+src="([^"]+)"/gi;
let m;
console.log("=== External Script URLs ===");
while ((m = scriptSrcRegex.exec(html)) !== null) {
  console.log(m[1]);
}

// Look for fetch() or XHR or XMLHttpRequest  
const fetchIdx = html.indexOf('fetch(');
if (fetchIdx !== -1) {
  console.log("\n=== fetch() usage ===");
  console.log(html.substring(fetchIdx - 50, fetchIdx + 300));
}

// Look for $.ajax or $.post
const jqAjax = html.indexOf('$.ajax');
const jqPost = html.indexOf('$.post');
if (jqAjax !== -1 || jqPost !== -1) {
  const idx = jqAjax !== -1 ? jqAjax : jqPost;
  console.log("\n=== jQuery AJAX usage ===");
  console.log(html.substring(idx - 50, idx + 300));
}

// Find variables with 'source' or 'embed' or 'server'
const varRegex = /(?:var|let|const)\s+\w*(?:source|embed|server|player|link)\w*\s*=/gi;
console.log("\n=== Variables with player-related names ===");
while ((m = varRegex.exec(html)) !== null) {
  console.log(html.substring(m.index, m.index + 100));
}

process.exit(0);
