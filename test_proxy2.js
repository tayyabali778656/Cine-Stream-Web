const BASE_URL = 'https://toon-stream.site';

async function fetchPage(url) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(fullUrl)}`;
  try {
      const response = await fetch(proxyUrl, {
          headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
      });
      const html = await response.text();
      console.log("Status:", response.status);
      console.log("HTML length:", html.length);
      return { html, status: response.status };
  } catch(e) {
      console.log(e);
      return { html: '', status: 500 };
  }
}

fetchPage('/episode/dandadan-episode-1/');
