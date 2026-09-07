const {MongoClient} = require('mongodb');
const config = require('./config');
async function run() {
  const c = new MongoClient(config.mongoUri, { family: 4 });
  await c.connect();
  const db = c.db('moviebox');
  const eps = await db.collection('episodes').find({animeSlug: 'that-time-i-got-reincarnated-as-a-slime', season: 4}).toArray();
  console.log('Season 4 episodes in DB:', eps.length);
  const epsAk = await db.collection('episodes').find({animeSlug: 'that-time-i-got-reincarnated-as-a-slime-season-4'}).toArray();
  console.log('Season 4 episodes (with wrong slug) in DB:', epsAk.length);
  await c.close();
}
run();
