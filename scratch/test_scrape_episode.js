const { getLiveEpisodes } = require('../services/toonstreamLive');

(async () => {
  const episodes = await getLiveEpisodes("one-piece", 1, 6);
  const ep = episodes.find(e => e.season === 1 && e.episode === 6);
  console.log("Episode 1x6 sources:", ep.sources);
})();
