require('dotenv').config();
const { MongoClient } = require('mongodb');
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const animekaiSvc = require('./services/animekaiLive');

const client = new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,connectTimeoutMS:20000,family:4,tls:true});
(async()=>{
  await client.connect();
  const col = client.db('moviebox').collection('anime');
  
  console.log('Searching AnimeKai for Yakuza Fiance...');
  const res = await animekaiSvc.searchAnime('Yakuza Fiance');
  
  if (res && res.results && res.results.length > 0) {
    const anime = res.results[0];
    console.log('Found on AnimeKai:', anime.title);
    
    // Fetch full details
    const details = await animekaiSvc.getAnimeDetails(anime.slug);
    if (details) {
      await col.updateOne(
        { id: details.id },
        { $set: { ...details, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log('Successfully saved to DB!');
    }
  } else {
    console.log('Not found on AnimeKai either.');
  }
  
  await client.close();
})().catch(e=>console.error(e.message));
