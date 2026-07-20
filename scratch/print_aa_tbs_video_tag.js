const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

let idx = html.indexOf('aa-tbs-video');
let count = 1;
while (idx !== -1) {
  console.log(`=== Occurrence ${count} (index: ${idx}) ===`);
  console.log(html.substring(idx - 100, idx + 200));
  idx = html.indexOf('aa-tbs-video', idx + 1);
  count++;
}
process.exit(0);
