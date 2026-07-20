const fs = require('fs');
const html = fs.readFileSync('scratch/one-piece-series.html', 'utf8');

// Find "season/2" context
let idx = html.indexOf('season/2');
while (idx !== -1) {
  console.log("=== 'season/2' at index", idx, "===");
  console.log(html.substring(idx - 200, idx + 300));
  console.log("---");
  idx = html.indexOf('season/2', idx + 1);
}

// Find "Season 2" context
idx = html.indexOf('Season 2');
while (idx !== -1) {
  console.log("=== 'Season 2' at index", idx, "===");
  console.log(html.substring(idx - 100, idx + 200));
  console.log("---");
  idx = html.indexOf('Season 2', idx + 1);
}

process.exit(0);
