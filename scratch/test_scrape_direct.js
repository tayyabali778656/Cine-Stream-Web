const { scrapeEpisodePlayer } = require('../services/toonstreamLive');

async function main() {
  console.log("Direct test of scrapeEpisodePlayer('/episode/one-piece-2x62/')...");
  const sources = await scrapeEpisodePlayer('/episode/one-piece-2x62/');
  console.log("Sources:", JSON.stringify(sources, null, 2));
  process.exit(0);
}

main();
