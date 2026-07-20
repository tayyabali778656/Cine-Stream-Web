const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const regex = /[^<>\n]*embed[^<>\n]*/gi;
let match;
let count = 0;
console.log("=== Occurrences of 'embed' ===");
while ((match = regex.exec(html)) !== null && count < 30) {
  console.log(match[0].trim());
  count++;
}
process.exit(0);
