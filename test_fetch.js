const BASE_URL = 'https://toon-stream.site';

async function fetchPage(url) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  try {
      const response = await fetch(fullUrl, {
          headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'max-age=0',
              'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Windows"',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1'
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
