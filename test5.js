const { MongoClient } = require('mongodb');
require('dotenv').config();

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const res = await db.collection('episodes').updateMany(
    { animeSlug: 'one-piece-dub-sub', season: { $gte: 21 } },
    { $set: { sources: [] } }
  );
  console.log('Updated:', res.modifiedCount);
  await client.close();
}
run().catch(console.dir);
