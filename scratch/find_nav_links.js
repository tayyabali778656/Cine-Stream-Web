const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find prev/next episode links from navigation buttons
const navRegex = /href="([^"]*\/episode\/[^"]*)"[^>]*(?:title="[^"]*"|class="[^"]*mar[^"]*")/gi;
let m;
console.log("=== Nav links in ep62.html ===");
while ((m = navRegex.exec(html)) !== null) {
  console.log(m[1], '|', m[0].substring(0, 100));
}

// Also look for "next" and "prev" patterns
const prevNextRegex = /(?:prev|next|svgpath)[^>]*href="([^"]+)"/gi;
while ((m = prevNextRegex.exec(html)) !== null) {
  console.log("prev/next:", m[1]);
}

// Find all anchor tags with episode URLs
const epLinkRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
const epLinks = new Set();
while ((m = epLinkRegex.exec(html)) !== null) {
  epLinks.add(m[1]);
}
console.log("\n=== All episode links in page ===");
epLinks.forEach(l => console.log(l));

process.exit(0);
