const { getLiveEpisodes } = require('../services/toonstreamLive');

(async () => {
  try {
    const slug = "kuroko's-basketball";
    console.log("Calling getLiveEpisodes for:", slug);
    const episodes = await getLiveEpisodes(slug, 1, 1);
    console.log("Total episodes returned:", episodes.length);
    console.log("Seasons present:", [...new Set(episodes.map(ep => ep.season))]);
    
    const s1e1 = episodes.find(ep => ep.season === 1 && ep.episode === 1);
    console.log("Season 1 Episode 1 details:", s1e1);
  } catch (err) {
    console.error(err);
  }
})();
