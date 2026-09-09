const fs = require('fs');
let content = fs.readFileSync('serve.js', 'utf8');

const helper = `
// ── In-Memory Cache for index.html (Performance Fix) ──────────────────────────
let cachedIndexHtml = null;
function getIndexHtml() {
  if (!cachedIndexHtml) {
    cachedIndexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  }
  return cachedIndexHtml;
}
`;

content = content.replace('const PUBLIC_DIR = __dirname;', 'const PUBLIC_DIR = __dirname;\n' + helper);
content = content.replace(/const htmlRaw = fs\.readFileSync\(path\.join\(PUBLIC_DIR, 'index\.html'\), 'utf8'\);/g, 'const htmlRaw = getIndexHtml();');

fs.writeFileSync('serve.js', content);
console.log('Replaced readFileSync with getIndexHtml()');
