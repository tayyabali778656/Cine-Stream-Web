const { connectDB, getCollection } = require('./db');
async function run() {
  await connectDB();
  const col = getCollection('episodes');
  const res = await col.updateMany({}, { $unset: { sources: '' } });
  console.log('Cleared sources for', res.modifiedCount, 'episodes');
  process.exit(0);
}
run();
