const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const idx = html.indexOf('id="aa-options"');
if (idx !== -1) {
  console.log("=== Player Section in ep62.html ===");
  console.log(html.substring(idx - 100, idx + 4000));
} else {
  console.log("Player section not found!");
}
process.exit(0);
