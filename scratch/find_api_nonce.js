const fs = require('fs');
const html = fs.readFileSync('scratch/ep62.html', 'utf8');

// Search for wp-json or REST API calls or nonces (for WordPress API)
const apiRegex = /wp-json[^"'\s]*/gi;
let m;
console.log("=== WordPress API endpoints ===");
while ((m = apiRegex.exec(html)) !== null) {
  console.log(m[0]);
}

// Search for nonce
const nonceRegex = /nonce[^"'\s]*[:=]\s*["']([^"']+)["']/gi;
console.log("\n=== Nonces ===");
while ((m = nonceRegex.exec(html)) !== null) {
  console.log(m[0].substring(0, 80));
}

// Find any variables set with episode ID or post ID
const postIdRegex = /post_id\s*[:=]\s*(\d+)|"post"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/gi;
console.log("\n=== Post IDs ===");
while ((m = postIdRegex.exec(html)) !== null) {
  console.log("post_id:", m[1] || m[2]);
}

// Look for ajax_url or action
const ajaxRegex = /ajax_url[^"'\s]*[:=]\s*["']([^"']+)["']/gi;
console.log("\n=== AJAX URLs ===");
while ((m = ajaxRegex.exec(html)) !== null) {
  console.log(m[0].substring(0, 120));
}

process.exit(0);
