const https = require('https');
function fetchPage(url) {
  const fullUrl = url.startsWith('http') ? url : 'https://animekai.be' + url;
  return new Promise((resolve) => {
    const req = https.get(fullUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ html: body, status: res.statusCode, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ html: '', status: 500, error: e.message }));
  });
}
async function run() {
  const r = await fetchPage('/watch/that-time-i-got-reincarnated-as-a-slime-season-4');
  console.log('Season 4 status:', r.status);
  
  if (r.status === 301 || r.status === 302 || r.status === 308) {
     console.log('Redirects to:', r.headers.location);
     const r2 = await fetchPage(r.headers.location);
     console.log('Redirect status:', r2.status);
     const links = r2.html.match(/href=["'][^"']*ep-\d+["']/g) || [];
     console.log('Links:', links.length, links.slice(0, 5));
     console.log('First 200 chars of HTML:', r2.html.substring(0, 200));
  } else {
    const links = r.html.match(/href=["'][^"']*ep-\d+["']/g) || [];
    console.log('Links:', links.length, links.slice(0, 5));
  }
}
run();
