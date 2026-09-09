require('dotenv').config();
const { MongoClient } = require('mongodb');
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const client = new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,connectTimeoutMS:20000,family:4,tls:true});
(async()=>{
  await client.connect();
  const col = client.db('moviebox').collection('anime');
  const results = await col.find({
    $or: [
      { title: /yakuza/i },
      { title: /raise wa/i },
      { title: /fiance/i },
      { title: /fiancé/i }
    ]
  }).toArray();
  console.log('Found:', results.length);
  results.forEach(r => console.log('- ' + r.title + ' (slug: ' + r.slug + ')'));
  await client.close();
})().catch(e=>console.error(e.message));
