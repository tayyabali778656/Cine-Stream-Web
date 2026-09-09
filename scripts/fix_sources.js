const fs = require('fs');

['app.js', 'temp_app.js', 'app_temp.js'].forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    let regex = /cineSubAdded = true;\s*\}\s*\}\s*\}\s*\}\s*\}/;
    if (regex.test(content)) {
       let matched = content.match(regex)[0];
       let repl = matched + '\n                  // 3. Fallback: Add any remaining sources\n                  for (const s of allRaw) {\n                    if (!usedUrls.has(s.url)) {\n                      sources.push(s);\n                      usedUrls.add(s.url);\n                    }\n                  }';
       content = content.replace(regex, repl);
       fs.writeFileSync(file, content);
       console.log('Fixed ' + file + ' with regex');
    } else {
       console.log('Target not found in ' + file);
    }
  }
});
