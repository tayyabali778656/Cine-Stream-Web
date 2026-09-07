const dbModule = require('./db');

async function run() {
  console.log('Connecting to MongoDB...');
  const db = await dbModule.connectDB();
  const episodesCol = dbModule.getCollection('episodes');

  console.log('Deleting orphaned Slime season 4 episodes...');
  await episodesCol.deleteMany({ animeSlug: 'that-time-i-got-reincarnated-as-a-slime-season-4' });

  console.log('Resetting akUpdatedAt for Slime episodes to force a refresh...');
  const result = await episodesCol.updateMany(
    { animeSlug: 'that-time-i-got-reincarnated-as-a-slime' },
    { $unset: { akUpdatedAt: "" } }
  );

  console.log(`Updated ${result.modifiedCount} Slime episodes.`);
  console.log('Done!');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
