const fs = require('fs');
const path = require('path');
const db = require('../db');
const liveSvc = require('../services/toonstreamLive');

const STATE_FILE = path.join(__dirname, 'crawler_state.json');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CATEGORIES = ['anime', 'cartoon', 'movie'];

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      return { currentCategoryIdx: 0, currentPage: 1 };
    }
  }
  return { currentCategoryIdx: 0, currentPage: 1 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function startCrawler() {
  console.log('Connecting to MongoDB...');
  await db.connectDB();
  console.log('Connected!');

  const state = loadState();
  let currentCategoryIdx = state.currentCategoryIdx || 0;
  let currentPage = state.currentPage || 1;
  const animeCol = db.getCollection('anime');
  let scrapedCount = 0;

  console.log(`Starting crawler from Category: ${CATEGORIES[currentCategoryIdx]}, Page: ${currentPage}...`);

  while (currentCategoryIdx < CATEGORIES.length) {
    const category = CATEGORIES[currentCategoryIdx];
    console.log(`Fetching Toonstream [${category}] page ${currentPage}...`);
    // Delay before fetching list page
    await delay(3000);

    const listData = await liveSvc.getLiveAnimeList(category, currentPage);
    const results = listData.results || [];

    if (results.length === 0) {
      console.log(`No more results found for ${category}. Moving to next category...`);
      currentCategoryIdx++;
      currentPage = 1;
      saveState({ currentCategoryIdx, currentPage });
      continue;
    }

    console.log(`Found ${results.length} items on [${category}] page ${currentPage}. Processing...`);

    for (const anime of results) {
      const slug = anime.slug;
      const id = anime.id || `toon_${slug}`;

      // Check if exists in DB
      const exists = await animeCol.findOne({ id });
      if (exists) {
        console.log(`[SKIPPED] ${anime.title} (already in DB)`);
        continue;
      }

      console.log(`[SCRAPING] ${anime.title} (${slug})...`);
      
      // Delay before deep scraping to avoid IP ban
      await delay(2500);
      
      try {
        // Fetch Details 
        const details = await liveSvc.getLiveAnimeDetails(id, slug);
        if (details) {
          details.id = id;
          details.updatedAt = new Date();
          await animeCol.updateOne({ id }, { $set: details }, { upsert: true });
        }

        // Delay between details and episodes
        await delay(2000);

        // Fetch Episodes 
        const episodes = await liveSvc.getLiveEpisodes(slug);
        
        if (episodes && episodes.length > 0) {
          const epCol = db.getCollection('episodes');
          const ops = episodes.map(ep => ({
            updateOne: {
              filter: { animeId: id, season: ep.season, episode: ep.episode },
              update: { $set: { animeId: id, ...ep } },
              upsert: true
            }
          }));
          await epCol.bulkWrite(ops);
          console.log(`  -> Saved ${episodes.length} episodes for ${anime.title}`);
        } else {
          console.log(`  -> No episodes found for ${anime.title}`);
        }

        scrapedCount++;

        // Extra 10-second delay every 5 animes
        if (scrapedCount % 5 === 0) {
          console.log(`[DELAY] Reached 5 animes. Sleeping for 10 seconds to stay safe...`);
          await delay(10000);
        }

      } catch (err) {
        console.error(`[ERROR] Failed to scrape ${anime.title}:`, err.message);
      }
    }

    // Save state after completing a page
    currentPage++;
    saveState({ currentCategoryIdx, currentPage });
    console.log(`Completed [${category}] page ${currentPage - 1}. State saved.`);
    
    if (currentPage > (listData.total_pages || 50)) {
      console.log(`Reached the last page of ${category}. Moving to next category...`);
      currentCategoryIdx++;
      currentPage = 1;
      saveState({ currentCategoryIdx, currentPage });
      continue;
    }
  }

  console.log('Crawler script execution completed.');
  process.exit(0);
}

startCrawler().catch(err => {
  console.error('Crawler crashed:', err);
  process.exit(1);
});
