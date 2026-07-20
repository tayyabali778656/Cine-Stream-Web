const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const regex = /<ul[^>]*>/gi;
let match;
console.log("=== All <ul ...> tags ===");
while ((match = regex.exec(html)) !== null) {
  console.log(match[0]);
}

const regex2 = /<div class="video-player"[\s\S]*?<\/div>/gi;
const match2 = html.match(regex2);
if (match2) {
  console.log("Found video-player:", match2[0]);
} else {
  const idx = html.indexOf('video-player');
  if (idx !== -1) {
    console.log("Context of video-player:", html.substring(idx - 100, idx + 1000));
  }
}
process.exit(0);
