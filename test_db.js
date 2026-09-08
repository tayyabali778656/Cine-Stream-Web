require('dotenv').config();
const { connectDB, getCollection } = require('./db.js');

(async () => {
  try {
    await connectDB();
    const epColl = getCollection('episodes');

    // Check if previously scraped episodes are still properly saved
    const prevScraped = [
      'ep_trapped-in-a-dating-sim-the-world-of-otome_1x5',
      'ep_trapped-in-a-dating-sim-the-world-of-otome_1x4',
      'ep_trapped-in-a-dating-sim-the-world-of-otome_1x3',
      'ep_trapped-in-a-dating-sim-the-world-of-otome_1x1',
      'ep_captain-tsubasa_1x7',
      'ep_captain-tsubasa_1x6',
    ];

    console.log("=== CHECKING PREVIOUSLY SCRAPED EPISODES ===\n");
    for (const id of prevScraped) {
      const ep = await epColl.findOne({ id });
      if (ep) {
        const cnt = ep.sources ? ep.sources.length : 0;
        const status = cnt > 0 ? `✅ ${cnt} servers` : `❌ EMPTY! Episode was re-cleared!`;
        console.log(`${id}: ${status}`);
      } else {
        console.log(`${id}: ❓ Not found in DB`);
      }
    }

    // Also check what's causing the total to INCREASE
    console.log("\n=== CHECKING NEW EMPTY EPISODES ===");
    const total = await epColl.countDocuments({ $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }] });
    console.log(`Total empty right now: ${total}`);

    // Check if these were recently added (in last 10 minutes)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentEmpty = await epColl.find({
      $or: [{ sources: { $exists: false } }, { sources: { $size: 0 } }],
      updatedAt: { $gte: tenMinAgo }
    }).limit(5).toArray();

    if (recentEmpty.length > 0) {
      console.log(`\nRecently added empty episodes (last 10 mins):`);
      for (const ep of recentEmpty) {
        console.log(`  - ${ep.id} (animeId: ${ep.animeId})`);
      }
    } else {
      console.log(`\nNo recently added empty episodes found.`);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
