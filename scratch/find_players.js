const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find all elements with class or ID containing "video" or "player" or "options"
const regex = /<[^>]+(class|id)="[^"]*(video|player|option|server|lnk)[^"]*"[^>]*>/gi;
let match;
let count = 0;
console.log("=== Matching Elements ===");
while ((match = regex.exec(html)) !== null && count < 60) {
  console.log(match[0].trim());
  count++;
}
process.exit(0);
