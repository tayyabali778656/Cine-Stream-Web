const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const regex = /aa-[a-zA-Z0-9_-]+/gi;
let match;
const set = new Set();
while ((match = regex.exec(html)) !== null) {
  set.add(match[0]);
}
console.log("=== All classes starting with aa- ===");
console.log([...set]);
process.exit(0);
