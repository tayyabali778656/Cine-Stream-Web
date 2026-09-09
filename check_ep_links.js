require('dotenv').config();
const { MongoClient } = require('mongodb');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 20000, family: 4, tls: true });
(async () => {
  await client.connect();
  const col = client.db('moviebox').collection('episodes');
  const total = await col.countDocuments();
  const empty = await col.aggregate([
    { $match: { $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }] } },
    { $count: 'n' }
  ]).toArray();
  const emptyCount = empty[0] ? empty[0].n : 0;
  const withSrc = total - emptyCount;
  console.log('Total episodes :', total);
  console.log('With sources   :', withSrc);
  console.log('Empty sources  :', emptyCount);
  console.log('Fill rate      :', ((withSrc / total) * 100).toFixed(1) + '%');
  await client.close();
})().catch(e => { console.error(e.message); process.exit(1); });
