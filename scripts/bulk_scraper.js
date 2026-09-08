require('dotenv').config();
const { connectDB, getCollection } = require('../db');
const toonstreamLive = require('../services/toonstreamLive');
const animekaiLive = require('../services/animekaiLive');

// Anti-ban configuration
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 7000;
const BREAK_AFTER_COUNT = 100;
const BREAK_DURATION_MS = 60000; // 1 minute break
const BLOCK_DETECT_THRESHOLD = 5; // If 5 in a row return 0 servers, pause
const BLOCK_PAUSE_MS = 10 * 60 * 1000; // 10 minutes

let isShuttingDown = false;

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log("\n[!] Ctrl+C detected! Stopping gracefully after current episode finishes...");
  isShuttingDown = true;
});

// Random delay helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1) + MIN_DELAY_MS);

async function runScraper() {
  await connectDB();
  const epColl = getCollection('episodes');
  if (!epColl) throw new Error("Could not connect to episodes collection");

  const query = {
    $or: [
      { sources: { $exists: false } },
      { sources: { $size: 0 } }
    ]
  };

  const totalEmpty = await epColl.countDocuments(query);
  console.log(`\n=== BULK SCRAPER STARTED ===`);
  console.log(`Found ${totalEmpty} episodes with empty servers.`);
  console.log(`Press Ctrl+C at any time to pause safely. Progress is automatically saved.\n`);

  if (totalEmpty === 0) {
    console.log("Nothing to scrape! Exiting.");
    return process.exit(0);
  }

  let count = 0;
  let emptyStreak = 0;

  // We fetch a cursor to avoid loading all 30k into memory
  const cursor = epColl.find(query);

  while (await cursor.hasNext()) {
    if (isShuttingDown) {
      console.log("Safely stopped. You can run this script again later to resume.");
      process.exit(0);
    }

    const ep = await cursor.next();
    count++;
    
    const isToonstream = ep.animeId && ep.animeId.startsWith('toon_');
    const slug = isToonstream ? ep.animeId.replace('toon_', '') : ep.animeSlug || ep.animeId;
    
    let newSources = [];
    let scraperUsed = "None";

    try {
      if (isToonstream) {
        scraperUsed = "ToonStream + AnimeKai";
        // Fetch ToonStream
        const resToon = await toonstreamLive.getLiveEpisodes(slug, ep.season, ep.episode);
        const targetToon = resToon.find(e => e.season === ep.season && e.episode === ep.episode);
        if (targetToon && targetToon.sources) newSources = [...targetToon.sources];

        // Fetch AnimeKai
        try {
          const resAk = await animekaiLive.getLiveEpisodes(slug, ep.season, ep.episode);
          const targetAk = resAk.find(e => e.season === ep.season && e.episode === ep.episode);
          if (targetAk && targetAk.sources) {
            const existingKeys = new Set(newSources.map(s => s.url + s.label));
            for (const src of targetAk.sources) {
              if (!existingKeys.has(src.url + src.label)) newSources.push(src);
            }
          }
        } catch (akErr) {
           console.log(`[!] AnimeKai scrape failed for ${slug}, proceeding with ToonStream only.`);
        }
      } else {
        scraperUsed = "AnimeKai";
        const res = await animekaiLive.getLiveEpisodes(slug, ep.season, ep.episode);
        const target = res.find(e => e.season === ep.season && e.episode === ep.episode);
        if (target && target.sources) newSources = target.sources;
      }

      // Merge and save just like our fixed backend code
      if (newSources.length > 0) {
        emptyStreak = 0; // reset streak
        // We do a merge in case another background process added something
        const latestDbEp = await epColl.findOne({ id: ep.id });
        let mergedSources = [...newSources];
        
        if (latestDbEp && latestDbEp.sources && latestDbEp.sources.length > 0) {
          const existingKeys = new Set(newSources.map(s => s.url + s.label));
          for (const src of latestDbEp.sources) {
            if (!existingKeys.has(src.url + src.label)) mergedSources.push(src);
          }
        }

        await epColl.updateOne(
          { id: ep.id },
          { $set: { sources: mergedSources, updatedAt: new Date() } }
        );
        
        console.log(`[${count}/${totalEmpty}] Scraped: ${ep.id} | ${scraperUsed} | ✅ Found ${newSources.length} servers`);
      } else {
        emptyStreak++;
        console.log(`[${count}/${totalEmpty}] Scraped: ${ep.id} | ${scraperUsed} | ❌ 0 servers found`);
      }

    } catch (err) {
      console.error(`[${count}/${totalEmpty}] Error scraping ${ep.id}: ${err.message}`);
      emptyStreak++;
    }

    // Smart Anti-Ban: Block Detection Pause
    if (emptyStreak >= BLOCK_DETECT_THRESHOLD) {
      console.log(`\n⚠️ WARNING: Found 0 servers ${emptyStreak} times in a row!`);
      console.log(`This might be a temporary IP block from the video hosts.`);
      console.log(`Taking a smart pause for ${BLOCK_PAUSE_MS / 60000} minutes to let the block expire...`);
      await sleep(BLOCK_PAUSE_MS);
      emptyStreak = 0; // reset after pause
    }

    // Smart Anti-Ban: Regular interval breaks
    if (count % BREAK_AFTER_COUNT === 0) {
      console.log(`\n💤 Taking a 1-minute smart break after scraping ${BREAK_AFTER_COUNT} episodes to keep IP safe...`);
      await sleep(BREAK_DURATION_MS);
    } else {
      // Smart Anti-Ban: Random delay between each request
      const delay = randomDelay();
      await sleep(delay);
    }
  }

  console.log("\n🎉 Bulk scraping completed successfully!");
  process.exit(0);
}

runScraper();
