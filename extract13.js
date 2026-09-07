const ts = require('./services/toonstreamLive.js');

async function test() {
  console.log('Scraping...');
  const servers = await ts.scrapeEpisodePlayer('https://toon-stream.site/episode/one-piece-21x892/');
  console.log('Found', servers.length, 'servers:');
  servers.forEach(s => console.log(s.label, s.url));
}
test().catch(console.error);
