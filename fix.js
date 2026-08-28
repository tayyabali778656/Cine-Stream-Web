const fs = require('fs');
let code = fs.readFileSync('serve.js', 'utf8');

// The error is around line 1518 where the backtick was stripped, producing <?xml instead of \<?xml
code = code.replace(/const xml = <\?xml/g, 'const xml = \<?xml');

fs.writeFileSync('serve.js', code);
