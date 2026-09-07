const fs = require('fs');
const path = require('path');
const { connectDB, getCollection } = require('../db');
const toonstreamLive = require('../services/toonstreamLive');
const animekaiLive = require('../services/animekaiLive');

const REPORT_FILE = path.join(__dirname, 'missing_report.txt');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendToReport(anime, reason) {
  const line = `${anime.title} (Slug: ${anime.id.replace('toon_', '')}) - ${reason}\n`;
  fs.appendFileSync(REPORT_FILE, line);
}

async function scrapeAnimeEpisodes(animeSlug, targetSeason = 1, fallbackTitle = '') {
  let sources = [];
  
  try {
    // 1. Try ToonStream
    const toonEps = await toonstreamLive.getLiveEpisodes(animeSlug, 1, 1);
    if (toonEps && toonEps.length > 0) {
      sources = toonEps;
      console.log(`[ToonStream] Found ${sources.length} episodes for ${animeSlug}`);
      return sources;
    }
  } catch (err) {
    console.log(`[ToonStream] Error for ${animeSlug}:`, err.message);
  }

  await sleep(2000); // rate limit

  try {
    // 2. Fallback to AnimeKai
    const searchQuery = fallbackTitle || animeSlug.replace(/-/g, ' ');
    const searchRes = await animekaiLive.searchAnime(searchQuery);
    
    if (searchRes && searchRes.results && searchRes.results.length > 0) {
      const bestMatch = searchRes.results.find(r => r.slug === animeSlug) || searchRes.results[0];
      const kaiEps = await animekaiLive.getLiveEpisodes(bestMatch.slug, 1, 1);
      
      if (kaiEps && kaiEps.length > 0) {
        sources = kaiEps;
        // Map animekai_ IDs to toon_ IDs to match database schema
        sources = sources.map(ep => ({
          ...ep,
          id: ep.id.replace('animekai_', 'toon_'),
          animeId: ep.animeId.replace('animekai_', 'toon_')
        }));
        console.log(`[AnimeKai] Found ${sources.length} episodes for ${animeSlug}`);
        return sources;
      }
    }
  } catch (err) {
    console.log(`[AnimeKai] Error for ${animeSlug}:`, err.message);
  }

  return sources;
}

async function runRepair() {
  await connectDB();
  const animeCol = getCollection('anime');
  const epCol = getCollection('episodes');

  if (fs.existsSync(REPORT_FILE)) {
    fs.unlinkSync(REPORT_FILE);
  }
  fs.writeFileSync(REPORT_FILE, "--- MISSING ANIME REPORT ---\n\n");

  const allAnime = await animeCol.find({ id: /^toon_/ }).toArray();
  console.log(`Starting repair for ${allAnime.length} anime...`);

  let repairedCount = 0;
  let notFoundCount = 0;

  for (let i = 0; i < allAnime.length; i++) {
    const anime = allAnime[i];
    const slug = anime.id.replace('toon_', '');
    
    const eps = await epCol.find({ animeId: anime.id }).toArray();
    const isTotallyMissing = eps.length === 0;
    const emptyEps = eps.filter(e => !e.sources || e.sources.length === 0);

    if (isTotallyMissing || emptyEps.length > 0) {
      console.log(`[${i+1}/${allAnime.length}] Repairing ${anime.title} (Missing: ${isTotallyMissing}, Empty: ${emptyEps.length})...`);
      
      const newEpisodes = await scrapeAnimeEpisodes(slug, 1, anime.title);
      
      if (newEpisodes && newEpisodes.length > 0) {
        const bulkOps = newEpisodes.map(ep => ({
          updateOne: {
            filter: { animeId: anime.id, season: ep.season, episode: ep.episode },
            update: { $set: { ...ep, animeId: anime.id, updatedAt: new Date() } },
            upsert: true
          }
        }));
        
        if (bulkOps.length > 0) {
          try {
            const res = await epCol.bulkWrite(bulkOps);
            console.log(` -> Upserted ${bulkOps.length} episodes!`);
            repairedCount++;
          } catch (dbErr) {
            console.log(` -> DB Error during upsert: ${dbErr.message}`);
          }
        }
      } else {
        console.log(` -> Failed to find sources.`);
        appendToReport(anime, isTotallyMissing ? "0 Episodes found" : `${emptyEps.length} empty episodes`);
        notFoundCount++;
      }
      
      await sleep(2000); // rate limit between animes
    }
  }

  console.log(`\n=== REPAIR COMPLETE ===`);
  console.log(`Successfully repaired: ${repairedCount} anime`);
  console.log(`Failed to find: ${notFoundCount} anime`);
  process.exit(0);
}

runRepair().catch(console.error);
