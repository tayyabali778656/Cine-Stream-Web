const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find the full serverConfig script and find the second fetch
const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = regex.exec(html)) !== null) {
  const content = m[1];
  if (content.includes('serverConfig')) {
    // Find all fetch() calls
    let fidx = 0;
    let fetchCount = 0;
    while (true) {
      fidx = content.indexOf('fetch(', fidx);
      if (fidx === -1) break;
      fetchCount++;
      console.log(`\n=== fetch() #${fetchCount} at pos ${fidx} ===`);
      console.log(content.substring(fidx - 50, fidx + 600));
      fidx++;
    }
    
    // Also look for the 'url' variable being constructed
    const urlLine = content.match(/(?:const|let|var)\s+url\s*=\s*[\s\S]{0,300}/m);
    if (urlLine) {
      console.log("\n=== url variable ===");
      console.log(urlLine[0].substring(0, 300));
    }
    break;
  }
}
process.exit(0);
