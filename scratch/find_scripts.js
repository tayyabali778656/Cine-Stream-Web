const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;
console.log("=== Scripts content search ===");
while ((match = regex.exec(html)) !== null) {
  const content = match[1];
  // Look for script content that might contain data
  if (content.includes('episodes') || content.includes('data') || content.includes('servers') || content.includes('var') || content.includes('const')) {
    if (content.length > 50 && content.length < 2000) {
      console.log(`Script ${count+1} (length: ${content.length}):`);
      console.log(content.trim());
      console.log("------------------------");
    }
  }
  count++;
}
process.exit(0);
