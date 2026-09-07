const animekaiSvc = require('../services/animekaiLive');
const { connectDB, getCollection } = require('../db');

async function addAnimeKaiToEp3() {
  await connectDB();
  const col = getCollection('episodes');

  console.log('Scraping AnimeKai EP3...');
  const eps = await animekaiSvc.getLiveEpisodes('that-time-i-got-reincarnated-as-a-slime', 1, 3);
  const ep3 = eps.find(e => e.season === 1 && e.episode === 3);

  if (!ep3 || !ep3.sources || ep3.sources.length === 0) {
    console.log('AnimeKai EP3 not found or no sources');
    return;
  }

  console.log('AnimeKai EP3 sources:', ep3.sources.map(s => s.label));

  // Push AnimeKai sources into existing EP3
  const result = await col.updateOne(
    { animeId: 'toon_that-time-i-got-reincarnated-as-a-slime', season: 1, episode: 3 },
    { $push: { sources: { $each: ep3.sources } }, $set: { updatedAt: new Date() } }
  );
  console.log('Updated:', result.modifiedCount, 'docs');
}

addAnimeKaiToEp3().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
