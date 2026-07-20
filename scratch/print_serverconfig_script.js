const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Find the SECOND large script block which has server processing
const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let m;
let scriptNum = 0;
while ((m = regex.exec(html)) !== null) {
  const content = m[1];
  if (content.includes('serverConfig')) {
    scriptNum++;
    console.log(`=== Script ${scriptNum} containing serverConfig (len=${content.length}) ===`);
    console.log(content.substring(0, 5000));
    console.log("--- END SCRIPT ---\n");
    if (scriptNum >= 2) break;
  }
}
process.exit(0);
