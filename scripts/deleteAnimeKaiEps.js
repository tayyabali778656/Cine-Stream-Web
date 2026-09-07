const dbModule = require('../db');

async function run() {
  console.log('Connecting to MongoDB...');
  await dbModule.connectDB();
  const episodesCol = dbModule.getCollection('episodes');

  // Find all episodes except those with 'one-piece' in the slug
  const eps = await episodesCol.find({ 
    animeSlug: { $not: /one-piece/ } 
  }).toArray();

  let toDeleteIds = [];

  for (const ep of eps) {
    if (ep.sources && ep.sources.length > 0) {
      // Check if ALL sources are from AnimeKai
      const isOnlyAnimeKai = ep.sources.every(s => s.label && (s.label.toLowerCase().includes('animekai') || s.label.toLowerCase().includes('ak')));
      
      if (isOnlyAnimeKai) {
        toDeleteIds.push(ep.id);
      }
    }
  }

  console.log(`Found ${toDeleteIds.length} missing episodes added solely from AnimeKai (excluding One Piece).`);
  
  if (toDeleteIds.length > 0) {
    console.log('Deleting them now...');
    const result = await episodesCol.deleteMany({ id: { $in: toDeleteIds } });
    console.log(`Deleted ${result.deletedCount} episodes.`);
  } else {
    console.log('Nothing to delete.');
  }

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
