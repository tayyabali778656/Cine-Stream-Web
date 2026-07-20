const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const lines = html.split('\n');
console.log("=== Lines containing 'iframe' ===");
lines.forEach((line, idx) => {
  if (line.includes('iframe')) {
    console.log(`Line ${idx+1}:`, line.trim());
  }
});

console.log("=== Lines containing 'server' ===");
lines.forEach((line, idx) => {
  if (line.includes('server')) {
    console.log(`Line ${idx+1}:`, line.trim());
  }
});
