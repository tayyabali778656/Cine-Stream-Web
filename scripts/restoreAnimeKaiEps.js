const dbModule = require('../db');
const animekaiSvc = require('../services/animekaiLive');
const logger = require('../utils/logger');

async function restore() {
  await dbModule.connectDB();
  const animeCol = dbModule.getCollection('anime');
  const episodesCol = dbModule.getCollection('episodes');

  // Find full anime added from AnimeKai
  const akAnimes = await animeCol.find({ 
    $or: [
      { source: 'animekai' },
      { id: { $regex: /^animekai_/ } }
    ]
  }).toArray();

  for (const anime of akAnimes) {
    const epCount = await episodesCol.countDocuments({ animeSlug: anime.slug });
    if (epCount === 0) {
      console.log(`Restoring episodes for: ${anime.title} (${anime.slug})`);
      try {
        const slug = anime.slug.replace(/^animekai_/, '');
        const eps = await animekaiSvc.getLiveEpisodes(slug, 1, 1);
        
        if (eps && eps.length > 0) {
          const bulkOps = eps.map(ep => {
            const epId = `ep_animekai_${slug}_${ep.season}x${ep.episode}`;
            return {
              updateOne: {
                filter: { id: epId },
                update: {
                  $set: {
                    id: epId,
                    animeId: anime.id,
                    animeSlug: anime.slug,
                    season: ep.season,
                    episode: ep.episode,
                    url: ep.url || `https://animekai.be/fake/${epId}`,
                    sources: ep.sources,
                    akUpdatedAt: new Date(),
                    createdAt: new Date()
                  }
                },
                upsert: true
              }
            };
          });
          
          await episodesCol.bulkWrite(bulkOps);
          console.log(`Restored ${eps.length} episodes for ${anime.title}`);
        } else {
          console.log(`No episodes found on AnimeKai for ${anime.title}`);
        }
      } catch (err) {
        console.error(`Failed to restore ${anime.title}:`, err.message);
      }
      
      // Delay to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('Restoration complete!');
  process.exit(0);
}

restore().catch(e => { console.error(e); process.exit(1); });
