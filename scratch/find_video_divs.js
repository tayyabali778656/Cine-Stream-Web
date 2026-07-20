const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find all elements with class containing "video" or "aa-tb" or "hdd"
const regex = /<div[^>]*class="[^"]*(video|aa-tb|hdd)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
let match;
let count = 0;
console.log("=== Matching Divs ===");
while ((match = regex.exec(html)) !== null && count < 30) {
  console.log(`Match ${count+1}:`, match[0].substring(0, 300));
  count++;
}
process.exit(0);
