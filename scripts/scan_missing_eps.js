const { connectDB, getCollection } = require('../db');
const toonstreamLive = require('../services/toonstreamLive');
const animekaiLive = require('../services/animekaiLive');

async function scanMissingEpisodes() {
  await connectDB();
  const animeCol = getCollection('anime');
  const epCol = getCollection('episodes');

  // Find all ToonStream anime
  const allAnime = await animeCol.find({ id: /^toon_/ }).toArray();
  console.log(`Found ${allAnime.length} ToonStream anime in DB.`);

  const missingEpisodesAnime = [];
  const emptySourcesEpisodes = [];

  for (const anime of allAnime) {
    const eps = await epCol.find({ animeId: anime.id }).toArray();
    
    if (eps.length === 0) {
      missingEpisodesAnime.push(anime);
    } else {
      const empty = eps.filter(e => !e.sources || e.sources.length === 0);
      if (empty.length > 0) {
        emptySourcesEpisodes.push({ anime, emptyEps: empty });
      }
    }
  }

  console.log(`Anime with 0 episodes in DB: ${missingEpisodesAnime.length}`);
  if (missingEpisodesAnime.length > 0) {
    missingEpisodesAnime.forEach(a => console.log(` - ${a.title} (${a.id})`));
  }

  console.log(`Anime with empty episodes (0 sources): ${emptySourcesEpisodes.length}`);
  if (emptySourcesEpisodes.length > 0) {
    emptySourcesEpisodes.forEach(item => {
      console.log(` - ${item.anime.title}: ${item.emptyEps.length} empty episodes`);
    });
  }

  process.exit(0);
}

scanMissingEpisodes().catch(console.error);
