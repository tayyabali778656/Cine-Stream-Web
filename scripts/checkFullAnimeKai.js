const dbModule = require('../db');

async function run() {
  await dbModule.connectDB();
  const animeCol = dbModule.getCollection('anime');
  const episodesCol = dbModule.getCollection('episodes');

  // Find anime that were added from animekai
  const akAnimes = await animeCol.find({ 
    $or: [
      { source: 'animekai' },
      { id: { $regex: /^animekai_/ } }
    ]
  }).toArray();

  console.log(`Found ${akAnimes.length} full anime added from AnimeKai.`);

  for (const anime of akAnimes) {
    const epCount = await episodesCol.countDocuments({ animeSlug: anime.slug });
    console.log(`Anime: ${anime.title} (Slug: ${anime.slug}) - Episodes left: ${epCount}`);
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
