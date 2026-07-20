const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find the serverConfig script and output the fetch URL
const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = regex.exec(html)) !== null) {
  const content = m[1];
  if (content.includes('serverConfig')) {
    // Find the fetch() call to see the URL being used
    const fetchMatch = content.match(/fetch\s*\(\s*([^)]{1,200})/);
    console.log("fetch() call:", fetchMatch ? fetchMatch[0] : "not found");
    
    // Find any URL variable assignment near "fetch"
    const urlVarMatch = content.match(/const\s+url\s*=\s*([^\n;]+)/g);
    if (urlVarMatch) urlVarMatch.forEach(x => console.log("url var:", x.substring(0, 150)));
    
    // Find all string literals that look like API paths
    const pathMatches = content.match(/["'`](\/[a-z][^"'`\s]{5,50})["'`]/g);
    if (pathMatches) pathMatches.forEach(p => console.log("path literal:", p));
    
    // Print sections around "fetch"
    let fidx = content.indexOf('await fetch');
    while (fidx !== -1) {
      console.log("\n--- fetch block ---");
      console.log(content.substring(fidx - 300, fidx + 400));
      fidx = content.indexOf('await fetch', fidx + 1);
    }
    break;
  }
}
process.exit(0);
