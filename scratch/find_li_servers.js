const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Search for aa-tbs-video in actual HTML markup (not scripts)
const divIdx = html.indexOf('<div class="aa-tbs-video"');
const ulIdx = html.indexOf('<ul class="aa-tbs-video"');
const divIdx2 = html.indexOf('class="aa-tbs-video"');
console.log("div.aa-tbs-video index:", divIdx);
console.log("ul.aa-tbs-video index:", ulIdx);
console.log("any aa-tbs-video tag index:", divIdx2);

if (divIdx2 !== -1) {
  // Print the tag  
  const tagStart = html.lastIndexOf('<', divIdx2);
  const tagEnd = html.indexOf('>', divIdx2);
  console.log("Tag:", html.substring(tagStart, tagEnd + 1));
  console.log("Context after:", html.substring(divIdx2, divIdx2 + 500));
}

// Find li items inside
const liRegex = /<li[^>]*class="[^"]*(?:btn|option)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
let m;
let count = 0;
console.log("\n=== All li.btn elements ===");
while ((m = liRegex.exec(html)) !== null && count < 20) {
  console.log("li:", m[0].substring(0, 200));
  count++;
}

process.exit(0);
