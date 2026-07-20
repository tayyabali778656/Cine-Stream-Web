const fs = require('fs');

const html = fs.readFileSync('scratch/ep62.html', 'utf8');
console.log("HTML loaded, length:", html.length);

const queries = ['options-', 'iframe', 'server', 'play', 'div'];
for (const q of queries) {
  const count = (html.match(new RegExp(q, 'gi')) || []).length;
  console.log(`Query "${q}" matches count:`, count);
}

// Let's print some lines around the first occurrence of "options-" or similar if any
const index = html.indexOf('ln');
if (index !== -1) {
  console.log("Found 'ln' at index:", index);
  console.log("Snippet:", html.substring(index, index + 300));
}
process.exit(0);
