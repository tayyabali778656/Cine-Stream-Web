'use strict';

const https = require('https');
const { connectDB, getCollection } = require('../db');
const logger = require('../utils/logger');
const animekaiSvc = require('../services/animekaiLive');

const BASE_URL = 'https://animekai.be';

// Sleep Helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helper to fetch HTML content
function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 404) { resolve({ html: '', status: 404 }); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', reject);
      }).on('error', (err) => {
        if (n > 0) setTimeout(() => attempt(n - 1), 2000);
        else reject(err);
      }).on('timeout', function () {
        this.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1), 3000);
        else reject(new Error(`Timeout: ${fullUrl}`));
      });
    };
    attempt(retries);
  });
}

// Scrape iframe players for a single AnimeKai episode
async function scrapeEpisodePlayer(epUrl) {
  try {
    const { html, status } = await fetchPage(epUrl);
    if (!html || status === 404) return [];

    const sources = [];
    const serverRegex = /<span class="server[^"]*"[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;

    while ((match = serverRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.startsWith('http')) continue;

      const label = match[2].trim().replace(/<[^>]+>/g, '');
      const isDub = url.includes('/dub');
      const suffix = isDub ? ' (Dub)' : ' (Sub)';

      sources.push({
        url: url,
        type: 'iframe',
        label: `AnimeKai ${label}${suffix}`,
        trusted: true
      });
    }
    return sources;
  } catch (err) {
    logger.warn(`Failed to scrape AnimeKai player: ${epUrl}`, err.message);
    return [];
  }
}

// Map absolute AnimeKai episode numbers to ToonStream season/episode mapping
function mapEpisodeToToonstream(akEp, tsEpisodes, slug) {
  if (!tsEpisodes || tsEpisodes.length === 0) return null;
  
  // Calculate absolute episode numbers for ToonStream episodes
  const sortedTsEps = [...tsEpisodes].sort((a, b) => a.season !== b.season ? a.season - b.season : a.episode - b.episode);
  let absCount = 0;
  for (let i = 0; i < sortedTsEps.length; i++) {
     const ep = sortedTsEps[i];
     if (i === 0) {
         absCount = ep.episode; 
     } else {
         if (ep.episode > absCount) {
             absCount = ep.episode; 
         } else {
             absCount++; 
         }
     }
     ep.absoluteEpisode = absCount;
  }

  // Check if it already exists
  const existing = sortedTsEps.find(e => e.absoluteEpisode === akEp.episode);
  if (existing) {
    return {
      id: existing.id,
      season: existing.season,
      episode: existing.episode,
      isExisting: true
    };
  }

  // If missing, find the season it belongs to
  const previousTsEps = sortedTsEps.filter(e => e.absoluteEpisode < akEp.episode);
  const lastTsEp = previousTsEps.length > 0 ? previousTsEps[previousTsEps.length - 1] : sortedTsEps[0];
  
  const season = lastTsEp.season;
  let episode;
  const isAbsolute = (lastTsEp.episode === lastTsEp.absoluteEpisode);
  if (isAbsolute) {
      episode = akEp.episode;
  } else {
      episode = lastTsEp.episode + (akEp.episode - lastTsEp.absoluteEpisode);
  }

  return {
    id: `ep_${slug}_${season}x${episode}`,
    season: season,
    episode: episode,
    isExisting: false
  };
}

async function run() {
  const start = Date.now();
  try {
    await connectDB();
    logger.info('animekai_crawler_started');

    const animeCol = getCollection('anime');
    const episodesCol = getCollection('episodes');

    let totalSaved = 0;
    
    // Scan only the first 5 pages of AnimeKai latest updates
    const maxPages = 5;
    
    for (let page = 1; page <= maxPages; page++) {
        const { results } = await animekaiSvc.searchAnime('', page);
        if (!results || results.length === 0) {
            logger.info(`animekai_crawl_reached_end_at_page: ${page}`);
            break;
        }
        
        logger.info(`scanning_animekai_page: ${page} | items: ${results.length}`);
        
        for (const akAnime of results) {
           const exists = await animeCol.findOne({ 
               $or: [
                   { slug: akAnime.slug },
                   { slug: akAnime.slug + '-sub' },
                   { slug: akAnime.slug + '-dub' },
                   { slug: akAnime.slug + '-dub-sub' },
                   { id: `animekai_${akAnime.slug}` }
               ]
           });
           
           if (!exists) {
               // Anime does not exist in DB: Scrape completely (metadata + episodes)
               logger.info(`found_animekai_exclusive: ${akAnime.slug}`);
               const details = await animekaiSvc.getAnimeDetails(akAnime.slug);
               if (details) {
                   await animeCol.updateOne(
                       { id: details.id },
                       { $set: { 
                           ...details, 
                           sub: akAnime.sub || details.sub || 0,
                           dub: akAnime.dub || details.dub || 0,
                           language: (akAnime.dub > 0) ? 'English' : 'Japanese',
                           createdAt: new Date(), 
                           updatedAt: new Date() 
                       } },
                       { upsert: true }
                   );
                   
                   // 2. Scrape episodes
                   let targetUrl = `/watch/${akAnime.slug}`;
                   let { html, status } = await fetchPage(targetUrl);
                   
                   const refreshMatch = html.match(/url='([^']+)'/i);
                   if (refreshMatch) {
                      let redirectUrl = refreshMatch[1].replace(/^https?:\/\/[^\/]+/, '');
                      const nextResp = await fetchPage(redirectUrl);
                      html = nextResp.html;
                   }

                   const epLinkRegex = new RegExp(`href="[^"]*\\/watch\\/${akAnime.slug}\\/ep-(\\d+)"`, 'gi');
                   let epMatch;
                   const akEpisodeNumbers = new Set();
                   while ((epMatch = epLinkRegex.exec(html)) !== null) {
                     akEpisodeNumbers.add(parseInt(epMatch[1], 10));
                   }
                   
                   const epsToScrape = Array.from(akEpisodeNumbers).sort((a, b) => a - b);
                   if (epsToScrape.length === 0) epsToScrape.push(1); // Movie fallback
                   
                   const concurrency = 5;
                   let updatedEps = 0;
                   for (let i = 0; i < epsToScrape.length; i += concurrency) {
                     const batch = epsToScrape.slice(i, i + concurrency);
                     await Promise.all(batch.map(async (epNum) => {
                        const epUrl = `/watch/${akAnime.slug}/ep-${epNum}`;
                        const sources = await scrapeEpisodePlayer(epUrl);
                        if (sources.length === 0) return;
                        
                        const epId = `ep_animekai_${akAnime.slug}_1x${epNum}`;
                        const newEp = {
                            id: epId,
                            animeId: details.id,
                            animeSlug: akAnime.slug,
                            season: 1,
                            episode: epNum,
                            title: `Episode ${epNum}`,
                            url: epUrl,
                            thumbnail: '',
                            sources: sources,
                            isMissingAnimeKai: true,
                            createdAt: new Date(),
                            akUpdatedAt: new Date()
                        };
                        await episodesCol.updateOne({ id: epId }, { $set: newEp }, { upsert: true });
                        updatedEps++;
                     }));
                   }
                   logger.info(`scraped_exclusive_anime_episodes: ${akAnime.slug} | total: ${updatedEps}`);
                   totalSaved++;
                   await sleep(500); 
               }
           } else {
               // Anime exists in DB: Skip metadata. Update episodes only.
               const slug = exists.slug || exists.id.replace(/^toon_/, '').replace(/^animekai_/, '');
               if (!slug) continue;
               
               const cleanSlug = akAnime.slug; // use animekai's native slug for watch page
               const tsEpisodes = await episodesCol.find({ animeSlug: slug }).toArray();
               
               let targetUrl = `/watch/${cleanSlug}`;
               let { html, status } = await fetchPage(targetUrl);
               
               const refreshMatch = html.match(/url='([^']+)'/i);
               if (refreshMatch) {
                  let redirectUrl = refreshMatch[1].replace(/^https?:\/\/[^\/]+/, '');
                  const nextResp = await fetchPage(redirectUrl);
                  html = nextResp.html;
               }

               const epLinkRegex = new RegExp(`href="[^"]*\\/watch\\/${cleanSlug}\\/ep-(\\d+)"`, 'gi');
               let epMatch;
               const akEpisodeNumbers = new Set();
               while ((epMatch = epLinkRegex.exec(html)) !== null) {
                 akEpisodeNumbers.add(parseInt(epMatch[1], 10));
               }

               const epsToScrape = Array.from(akEpisodeNumbers).sort((a, b) => a - b);
               if (epsToScrape.length === 0) epsToScrape.push(1); 

               let updatedEps = 0;
               const concurrency = 5;
               for (let i = 0; i < epsToScrape.length; i += concurrency) {
                 const batch = epsToScrape.slice(i, i + concurrency);
                 await Promise.all(batch.map(async (epNum) => {
                    const mapping = tsEpisodes.length > 0 ? mapEpisodeToToonstream({ episode: epNum }, tsEpisodes, slug) : null;
                    
                    let epId, season, episode, isExisting;
                    if (mapping) {
                        epId = mapping.id; season = mapping.season; episode = mapping.episode; isExisting = mapping.isExisting;
                    } else {
                        epId = `ep_${slug}_1x${epNum}`; season = 1; episode = epNum; isExisting = false;
                    }

                    const epUrl = `/watch/${cleanSlug}/ep-${epNum}`;
                    const sources = await scrapeEpisodePlayer(epUrl);
                    if (sources.length === 0) return;

                    if (isExisting) {
                       const tsEp = tsEpisodes.find(e => e.id === epId);
                       const existingUrls = new Set((tsEp.sources || []).map(s => s.url));
                       let added = false;
                       for (const src of sources) {
                           if (!existingUrls.has(src.url)) {
                               if (!tsEp.sources) tsEp.sources = [];
                               tsEp.sources.push(src);
                               added = true;
                           }
                       }
                       if (added) {
                           await episodesCol.updateOne(
                               { id: epId },
                               { $set: { sources: tsEp.sources, akUpdatedAt: new Date() } }
                           );
                           updatedEps++;
                       }
                    } else {
                       const newEp = {
                           id: epId,
                           animeId: exists.id,
                           animeSlug: slug,
                           season: season,
                           episode: episode,
                           title: `Episode ${episode}`,
                           url: epUrl,
                           thumbnail: '',
                           sources: sources,
                           isMissingAnimeKai: true,
                           createdAt: new Date(),
                           akUpdatedAt: new Date()
                       };
                       await episodesCol.updateOne({ id: epId }, { $set: newEp }, { upsert: true });
                       updatedEps++;
                    }
                 }));
               }
               
               if (updatedEps > 0) {
                   logger.info(`merged_animekai_servers_for: ${slug} | episodes_updated: ${updatedEps}`);
                   totalSaved++;
               }
               await sleep(500);
           }
        }
        await sleep(1000); 
    }

    logger.info('animekai_crawler_finished', { duration_ms: Date.now() - start, totalSaved });
  } catch (err) {
    logger.error('animekai_crawler_fatal', err);
    throw err;
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
