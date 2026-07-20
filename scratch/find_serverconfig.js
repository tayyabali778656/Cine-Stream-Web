const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find "serverConfig" context
const idx = html.indexOf('serverConfig');
if (idx !== -1) {
  console.log("=== serverConfig context ===");
  console.log(html.substring(idx - 200, idx + 800));
}

// Also find the 'fetch(url' context to get the full fetch logic
const fetchIdx = html.indexOf('let serverConfig = [];');
if (fetchIdx !== -1) {
  console.log("\n=== serverConfig fetch logic ===");
  console.log(html.substring(fetchIdx - 200, fetchIdx + 1500));
}

process.exit(0);
