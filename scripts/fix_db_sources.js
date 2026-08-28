const db = require('../db.js');
const axios = require('axios');

async function extractRealUrl(embedUrl) {
  try {
    const res = await axios.get(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://toon-stream.site/'
      },
      timeout: 5000
    });
    const embedHtml = res.data;
    if (embedHtml) {
      const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i) || embedHtml.match(/<iframe[^>]+data-src=["']([^"']+)["']/i);
      if (iframeMatch) {
        let realUrl = iframeMatch[1];
        if (realUrl.startsWith('//')) realUrl = 'https:' + realUrl;
        if (realUrl.startsWith('/')) realUrl = `https://toon-stream.site${realUrl}`;
        return realUrl;
      }
    }
  } catch (err) {
    // console.warn(`Failed to extract real URL from ${embedUrl}`);
  }
  return embedUrl;
}

async function fixDbSources() {
  await db.connectDB();
  const episodesCol = db.getCollection('episodes');
  
  // Find all episodes that have a ToonStream embed URL in their sources
  const episodes = await episodesCol.find({ "sources.url": { $regex: /toon-stream\.site\/embed/ } }).toArray();
  console.log(`Found ${episodes.length} episodes with old ToonStream embed URLs.`);
  
  let updatedCount = 0;
  let batchCount = 0;
  
  // Process in batches of 50 episodes at a time
  const batchSize = 50;
  for (let i = 0; i < episodes.length; i += batchSize) {
    const batch = episodes.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (ep) => {
      let modified = false;
      const promises = ep.sources.map(async (src) => {
        if (src.url.includes('toon-stream.site/embed')) {
          const realUrl = await extractRealUrl(src.url);
          if (realUrl !== src.url) {
            src.url = realUrl;
            modified = true;
          }
        }
      });
      await Promise.all(promises);
      
      if (modified) {
        await episodesCol.updateOne(
          { _id: ep._id },
          { $set: { sources: ep.sources } }
        );
        updatedCount++;
      }
    }));
    
    batchCount++;
    console.log(`Processed batch ${batchCount}/${Math.ceil(episodes.length / batchSize)} - Total updated: ${updatedCount}`);
  }
  
  console.log(`Finished fixing ${updatedCount} episodes! You can now test Toonstream shutdown.`);
  process.exit(0);
}

fixDbSources().catch(err => {
  console.error(err);
  process.exit(1);
});
