const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const match = html.match(/<ul[^>]+class="[^"]*aa-tbs-video[^"]*"[\s\S]*?<\/ul>/gi);
if (match) {
  console.log("Found aa-tbs-video:", match[0]);
} else {
  console.log("aa-tbs-video not found in HTML!");
  // Let's print around the first occurrence of "aa-tbs-video"
  const idx = html.indexOf("aa-tbs-video");
  if (idx !== -1) {
    console.log("Context of aa-tbs-video:", html.substring(idx - 100, idx + 1000));
  }
}
process.exit(0);
