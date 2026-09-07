const dbModule = require('../db');

async function check() {
  await dbModule.connectDB();
  const episodesCol = dbModule.getCollection('episodes');

  // Find all episodes except one-piece
  const eps = await episodesCol.find({ 
    animeSlug: { $ne: 'one-piece' } 
  }).toArray();

  let countToDelete = 0;
  let sampleDeletes = [];

  for (const ep of eps) {
    if (ep.sources && ep.sources.length > 0) {
      // Check if ALL sources are from AnimeKai
      const isOnlyAnimeKai = ep.sources.every(s => s.label && (s.label.toLowerCase().includes('animekai') || s.label.toLowerCase().includes('ak')));
      
      if (isOnlyAnimeKai) {
        countToDelete++;
        if (sampleDeletes.length < 5) {
          sampleDeletes.push({
            id: ep.id,
            animeSlug: ep.animeSlug,
            season: ep.season,
            episode: ep.episode,
            sources: ep.sources.map(s => s.label)
          });
        }
      }
    }
  }

  console.log(`Found ${countToDelete} episodes that only have AnimeKai sources (excluding one-piece).`);
  console.log('Sample:', JSON.stringify(sampleDeletes, null, 2));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
