const { getLiveEpisodes } = require('../services/toonstreamLive');

(async () => {
  console.time("getLiveEpisodes");
  try {
    const episodes = await getLiveEpisodes("one-piece", 1, 1);
    console.log("Returned episodes:", episodes.length);
    if (episodes.length > 0) {
      console.log("First ep:", episodes[0]);
    }
  } catch (e) {
    console.error("Error fetching episodes:", e);
  }
  console.timeEnd("getLiveEpisodes");
})();
