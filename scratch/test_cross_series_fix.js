const { getLiveEpisodes } = require('../services/toonstreamLive');

async function main() {
  console.log("Testing one-piece S2E62 (should now auto-redirect to wano-arc)...");
  const episodes = await getLiveEpisodes('one-piece', 2, 62);
  
  const ep62 = episodes.find(e => e.season === 2 && e.episode === 62);
  if (ep62) {
    console.log("✅ Season 2 Episode 62 found!");
    console.log("Sources:", JSON.stringify(ep62.sources, null, 2));
  } else {
    console.log("❌ Episode not found!");
    console.log("All seasons found:", [...new Set(episodes.map(e => e.season))].sort((a,b)=>a-b));
  }
  
  process.exit(0);
}

main();
