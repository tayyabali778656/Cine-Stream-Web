const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Search for 'options-' pattern (the server divs)
const idx = html.indexOf('options-');
if (idx !== -1) {
  console.log("Found 'options-' at index:", idx);
  console.log(html.substring(idx - 100, idx + 400));
} else {
  console.log("NOT FOUND: 'options-' not in static HTML");
}

// Search for iframes
const iframeRegex = /<iframe[^>]*src="([^"]+)"/gi;
let m;
console.log("\n=== All iframes in ep62.html ===");
while ((m = iframeRegex.exec(html)) !== null) {
  console.log("iframe src:", m[1]);
}

// Search for data-src
const dsRegex = /data-src="([^"]+)"/gi;
console.log("\n=== All data-src in ep62.html ===");
while ((m = dsRegex.exec(html)) !== null) {
  console.log("data-src:", m[1]);
}

process.exit(0);
