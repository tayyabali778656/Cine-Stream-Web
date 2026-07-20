const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const idx = html.indexOf('class="options');
if (idx !== -1) {
  console.log("Context of options list class:");
  console.log(html.substring(idx - 100, idx + 1500));
} else {
  console.log("options list class not found!");
}
process.exit(0);
