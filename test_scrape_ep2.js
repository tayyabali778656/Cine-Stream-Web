const { getLiveEpisodes } = require('./services/toonstreamLive');

(async () => {
  try {
    console.log("Scraping Grand Blue Dreaming...");
    const episodes = await getLiveEpisodes('grand-blue-dreaming', 1, 1);
    const ep1 = episodes.find(e => e.season === 1 && e.episode === 1);
    console.log("Ep1 sources count:", ep1 ? ep1.sources.length : 0);
    console.log("Ep1 sources:", JSON.stringify(ep1 ? ep1.sources : null, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
