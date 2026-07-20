const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const regex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
let match;
console.log("=== List items containing 'server' or 'play' ===");
while ((match = regex.exec(html)) !== null) {
  const content = match[0];
  if (content.toLowerCase().includes('server') || content.toLowerCase().includes('play')) {
    // Only print if under 300 chars to avoid noise
    if (content.length < 300) {
      console.log(content.trim());
    }
  }
}
process.exit(0);
