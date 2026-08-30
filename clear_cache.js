require('dotenv').config();
const { connectDB, getCollection } = require('./db');

async function run() {
  await connectDB();
  const col = getCollection('episodes');
  const result = await col.updateMany(
    { "sources.label": { $in: ["1", "2", "3", "4", "5", "6", "Server 1", "Server 2"] } },
    { $unset: { sources: "" } }
  );
  console.log('Cleared bad sources cache:', result);
  process.exit(0);
}
run().catch(err => {
  console.error(err);
  process.exit(1);
});
