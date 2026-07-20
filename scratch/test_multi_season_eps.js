const { getLiveEpisodes } = require('../services/toonstreamLive');

async function main() {
  const tests = [
    { season: 2, episode: 62 },  // First ep of season 2
    { season: 2, episode: 63 },  // Second ep of season 2  
    { season: 2, episode: 77 },  // Last ep of season 2 (if exists)
    { season: 3, episode: 78 },  // First ep of season 3
    { season: 3, episode: 80 },  // Middle of season 3
  ];
  
  for (const test of tests) {
    console.log(`\n=== Testing S${test.season}E${test.episode} ===`);
    const episodes = await getLiveEpisodes('one-piece', test.season, test.episode);
    const ep = episodes.find(e => e.season === test.season && e.episode === test.episode);
    if (ep) {
      const srcUrls = (ep.sources || []).map(s => `${s.label}: ${s.url.split('/').pop()}`);
      console.log(`✅ Found! Sources (${(ep.sources||[]).length}):`, srcUrls.join(', '));
    } else {
      console.log('❌ Episode not found in list');
    }
  }
  
  process.exit(0);
}

main();
