const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find the fetch() that loads episodes list (not public/servers)
// Look for the pattern from earlier: const html = await fetch(url, {...
const idx = html.indexOf('const html = await fetch(url');
if (idx !== -1) {
  console.log("=== episode list fetch ===");
  console.log(html.substring(idx - 600, idx + 600));
} else {
  console.log("Not found: 'const html = await fetch(url'");
  
  // Try variations
  const idx2 = html.indexOf('await fetch(url');
  if (idx2 !== -1) {
    console.log("=== await fetch(url context ===");
    console.log(html.substring(idx2 - 600, idx2 + 600));
  } else {
    console.log("Also not found: 'await fetch(url'");
  }
}

// Find where "url" is constructed near season-btn or season fetching
const seasonFetchIdx = html.indexOf('data-url');
if (seasonFetchIdx !== -1) {
  console.log("\n=== data-url context (first occurrence in HTML) ===");
  console.log(html.substring(seasonFetchIdx - 100, seasonFetchIdx + 500));
}

process.exit(0);
