const fs = require('fs');
let content = fs.readFileSync('serve.js', 'utf8');

const target = `const fallbackInjected = htmlRaw
            .replace(new RegExp('<link id="seo-canonical"[^>]*>'), \`<link id="seo-canonical" rel="canonical" href="\${canonical}">\`)
            .replace(new RegExp('<meta id="og-url"[^>]*>'), \`<meta id="og-url" property="og:url" content="\${canonical}">\`);`;

const replacement = `const fallbackTitle = \`Watch \${toonId ? toonId.replace('toon_', '').replace(/-/g, ' ') : 'Anime'} Online\`;
          const fallbackInjected = htmlRaw
            .replace(new RegExp('<title id="seo-title">[^<]*</title>'), \`<title id="seo-title">\${fallbackTitle} | CineStream</title>\`)
            .replace(new RegExp('<meta id="seo-desc"[^>]*>'), \`<meta id="seo-desc" name="description" content="Watch \${fallbackTitle} in Hindi Dubbed on CineStream.">\`)
            .replace(new RegExp('<link id="seo-canonical"[^>]*>'), \`<link id="seo-canonical" rel="canonical" href="\${canonical}">\`)
            .replace(new RegExp('<meta id="og-url"[^>]*>'), \`<meta id="og-url" property="og:url" content="\${canonical}">\`);`;

content = content.replace(target, replacement);
fs.writeFileSync('serve.js', content);
console.log("Replaced successfully!");
