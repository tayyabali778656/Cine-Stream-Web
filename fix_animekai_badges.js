require('dotenv').config();
const { MongoClient } = require('mongodb');
const dns = require('dns'); dns.setServers(['8.8.8.8','1.1.1.1']);
const animekaiSvc = require('./services/animekaiLive');

const client = new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:15000,connectTimeoutMS:20000,family:4,tls:true});

async function run() {
  try {
    await client.connect();
    const db = client.db('moviebox');
    const animeCol = db.collection('anime');
    
    // Find all AnimeKai animes in DB
    const items = await animeCol.find({ id: /^animekai_/ }).toArray();
    console.log(`Found ${items.length} AnimeKai animes in database to fix.`);
    
    let updatedCount = 0;
    
    for (const item of items) {
      const cleanSlug = item.slug.replace(/^animekai_/, '');
      console.log(`Checking ${cleanSlug}...`);
      
      // We can use search to get the exact sub/dub count easily
      const searchQuery = item.title || cleanSlug.replace(/-/g, ' ');
      const searchRes = await animekaiSvc.searchAnime(searchQuery);
      
      let match = null;
      if (searchRes && searchRes.results) {
         match = searchRes.results.find(r => r.slug === cleanSlug) || searchRes.results[0];
      }
      
      if (match) {
         const newSub = match.sub || 0;
         const newDub = match.dub || 0;
         const newLanguage = newDub > 0 ? 'English' : 'Japanese';
         
         if (item.sub !== newSub || item.dub !== newDub || item.language !== newLanguage) {
             await animeCol.updateOne(
                 { id: item.id },
                 { $set: { sub: newSub, dub: newDub, language: newLanguage } }
             );
             console.log(` -> Updated ${cleanSlug}: sub=${newSub}, dub=${newDub}, lang=${newLanguage}`);
             updatedCount++;
         } else {
             console.log(` -> ${cleanSlug} is already correct.`);
         }
      }
      
      // Small delay to prevent API rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`Done! Updated ${updatedCount} animes.`);
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();
