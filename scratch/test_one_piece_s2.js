const { getLiveEpisodes } = require('../services/toonstreamLive');

async function main() {
  console.log("Fetching episodes for 'one-piece' season 2, ep 62...");
  const episodes = await getLiveEpisodes('one-piece', 2, 62);
  
  const allSeasons = [...new Set(episodes.map(e => e.season))].sort((a, b) => a - b);
  console.log("Seasons found:", allSeasons);
  
  const s2eps = episodes.filter(e => e.season === 2);
  console.log(`Season 2 episodes count: ${s2eps.length}`);
  s2eps.slice(0, 5).forEach(e => {
    console.log(`  S2E${e.episode}: url=${e.url} | sources=${JSON.stringify(e.sources)}`);
  });
  
  process.exit(0);
}

main();
