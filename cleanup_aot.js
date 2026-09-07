const dbModule = require('./db');

async function run() {
  console.log('Connecting to MongoDB...');
  const db = await dbModule.connectDB();
  const episodesCol = dbModule.getCollection('episodes');

  console.log('Deleting extra episodes for Attack on Titan Season 5 (episodes > 2)...');
  const result = await episodesCol.deleteMany({
    animeSlug: 'attack-on-titan',
    season: 5,
    episode: { $gt: 2 }
  });

  console.log(`Deleted ${result.deletedCount} extra episodes.`);
  console.log('Done!');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
