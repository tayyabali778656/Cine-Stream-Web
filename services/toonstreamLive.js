'use strict';

const https = require('https');
const logger = require('../utils/logger');

const BASE_URL = 'https://toon-stream.site';
const DISABLE_SCRAPING = process.env.DISABLE_TOONSTREAM === 'true';

let upcomingCache = null;
let upcomingCacheTime = 0;

function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// Helper to fetch HTML content from ToonStream
function fetchPage(url, retries = 2) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve) => {
    const attempt = (n) => {
      const req = https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': BASE_URL,
        },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 404) {
          resolve({ html: '', status: 404 });
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchPage(res.headers.location));
        }
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ html: body, status: res.statusCode }));
        res.on('error', () => resolve({ html: '', status: 500 }));
      });

      req.on('error', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 1000);
        else resolve({ html: '', status: 500 });
      });

      req.on('timeout', () => {
        req.destroy();
        if (n > 0) setTimeout(() => attempt(n - 1), 1000);
        else resolve({ html: '', status: 504 });
      });
    };
    attempt(retries);
  });
}

// Scrape iframe players from an episode or movie play page
// Uses ToonStream's real server names (Ruby, cloudy, Moly, etc.) for stable labelling
// Smart fallback: if episode page has no player, detects the real parent series and scrapes from there
async function scrapeEpisodePlayer(epUrl, _depth = 0) {
  try {
    const { html } = await fetchPage(epUrl);
    if (!html) return [];

    // Step 1: Parse the server selector list to build a map of options-N -> real server name
    // Structure: <li><a href="#options-N">Server <span>N</span><span class="server">NAME</span></a></li>
    const serverMap = {}; // 'options-0' -> { name: 'Ruby', num: 1 }
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
      const liHtml = liMatch[1];
      const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
      
      const spans = [...liHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map(m => m[1].trim());
      let serverName = 'Server';
      let serverNumMatch = null;
      
      if (spans.length >= 2) {
        serverNumMatch = spans[0];
        serverName = spans[1];
      } else if (spans.length === 1) {
        if (!isNaN(parseInt(spans[0]))) {
          serverNumMatch = spans[0];
        } else {
          serverName = spans[0];
        }
      }
      
      const classMatch = liHtml.match(/<span[^>]*class=["']server["'][^>]*>([\s\S]*?)<\/span>/i);
      if (classMatch) {
        serverName = classMatch[1].trim();
      }

      if (hrefMatch) {
        const optionId = hrefMatch[1];
        if (!isNaN(serverName) || serverName === '') {
          serverName = 'Server';
        }
        const serverNum = serverNumMatch ? parseInt(serverNumMatch, 10) : Object.keys(serverMap).length + 1;
        serverMap[optionId] = { name: serverName, num: serverNum };
      }
    }

    // Step 2: Parse all option divs and map options-N -> embed URL (supports both src and data-src, and single/double quotes)
    const embedMap = {}; // 'options-0' -> 'https://toon-stream.site/embed/xxx'
    const optionDivRegex = /id=["']?(options-\d+)["']?[\s\S]*?(?:\bsrc\b|\bdata-src\b)=["']([^"']+)["']/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `${BASE_URL}${embedUrl}`;
      if (!embedMap[optMatch[1]]) {
        embedMap[optMatch[1]] = embedUrl;
      }
    }

    // Step 3: Build final server list using real names if available, fallback to position
    let servers = [];
    const optionIds = Object.keys(embedMap).sort((a, b) => {
      const na = parseInt(a.replace('options-', ''), 10);
      const nb = parseInt(b.replace('options-', ''), 10);
      return na - nb;
    });

    // We fetch the real iframe URLs in parallel if they are hidden behind ToonStream's embed proxy
    const resolvedServers = await Promise.all(optionIds.map(async (optId) => {
      let embedUrl = embedMap[optId];
      // Filter out tracking/ads iframes
      if (
        embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
        embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
        embedUrl.includes('youtube.com')
      ) return null;

      // Extract real URL if it's ToonStream's internal embed
      if (embedUrl.includes(BASE_URL) || embedUrl.startsWith('/')) {
        try {
          const { html: embedHtml } = await fetchPage(embedUrl);
          if (embedHtml) {
            const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i) || embedHtml.match(/<iframe[^>]+data-src=["']([^"']+)["']/i);
            if (iframeMatch) {
              let realUrl = iframeMatch[1];
              if (realUrl.startsWith('//')) realUrl = 'https:' + realUrl;
              if (realUrl.startsWith('/')) realUrl = `${BASE_URL}${realUrl}`;
              embedUrl = realUrl;
            }
          }
        } catch (err) {
          logger.warn(`Failed to extract real URL from embed: ${embedUrl}`);
        }
      }

      const serverInfo = serverMap[optId];
      const label = serverInfo ? `${serverInfo.name}` : `Server`;
      return { url: embedUrl, type: 'iframe', label };
    }));

    servers = resolvedServers.filter(Boolean);
    // Fix labels if fallback was used
    servers.forEach((s, idx) => {
      if (s.label === 'Server') s.label = `Server ${idx + 1}`;
    });

    // ── Cross-series redirect fix ────────────────────────────────────────────────
    // Some episodes (e.g. /episode/one-piece-2x62/) have no player in their static
    // HTML because ToonStream hosts them under a DIFFERENT series slug
    // (e.g. /series/one-piece-wano-arc/).
    //
    // KEY INSIGHT: Every such episode page already contains the FULL linked episode
    // list for the real series in its sidebar (one-piece-wano-arc-1x1 through 1x61).
    //
    // Strategy:
    //   1. Extract original slug (e.g. 'one-piece'), season (e.g. 2), ep (e.g. 62)
    //   2. Compute CUMULATIVE position across ALL seasons 2, 3, 4... of the original
    //      slug (since Season 2 has 16 eps, Season 3 starts at global pos 16, etc.)
    //   3. Find the episode at that global position in the in-page episode list
    if (servers.length === 0 && _depth === 0) {
      // Extract slug/season/ep from the original URL: /episode/one-piece-2x62/
      const origNumMatch = epUrl.match(/\/([^/]+)-(\d+)x(\d+)\//);
      if (origNumMatch) {
        const origSlug = origNumMatch[1];              // e.g. 'one-piece'
        const origSeason = parseInt(origNumMatch[2], 10); // e.g. 2
        const origEpNum = parseInt(origNumMatch[3], 10); // e.g. 62

        // Only proceed if page links to a DIFFERENT real series
        const dataUrlMatch = html.match(/data-url="\/series\/([^/"]+)\/season\/\d+"/);
        if (dataUrlMatch && dataUrlMatch[1] !== origSlug) {

          // Step 1: Collect all season URLs of the real series from the page
          const seasonBtnRegex = /data-url="(\/series\/[^/"]+\/season\/\d+)"/gi;
          let sm;
          const realSeasonUrls = [];
          while ((sm = seasonBtnRegex.exec(html)) !== null) {
            if (!realSeasonUrls.includes(sm[1])) {
              realSeasonUrls.push(sm[1]);
            }
          }

          // Step 2: Collect all episode links from THIS page (already loaded, usually Season 1)
          const inPageEpRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
          let em;
          const allRealEps = [];
          const seenEps = new Set();
          while ((em = inPageEpRegex.exec(html)) !== null) {
            const epUrlStr = em[1];
            if (!seenEps.has(epUrlStr)) {
              seenEps.add(epUrlStr);
              allRealEps.push(epUrlStr);
            }
          }

          if (allRealEps.length > 0) {
            // Step 3: Compute CUMULATIVE position of the requested episode
            //   by fetching each season >= 2 from the original slug and counting
            //   how many episodes come before our target episode globally.
            let cumulativePos = 0;
            let foundInSeason = false;

            for (let s = 2; s <= origSeason; s++) {
              const { html: sHtml } = await fetchPage(`/series/${origSlug}/season/${s}`);
              if (!sHtml) continue;

              const sEpRegex = /href="([^"]*\/episode\/[^"]*-(\d+)x(\d+)\/)"/gi;
              const sEps = [];
              while ((em = sEpRegex.exec(sHtml)) !== null) {
                sEps.push({ e: parseInt(em[3], 10) });
              }
              sEps.sort((a, b) => a.e - b.e);

              if (s === origSeason) {
                // Find position of our episode within this season
                const posInSeason = sEps.findIndex(ep => ep.e === origEpNum);
                if (posInSeason >= 0) {
                  cumulativePos += posInSeason;
                  foundInSeason = true;
                }
                break;
              } else {
                // Add all episodes of this earlier season to cumulative count
                cumulativePos += sEps.length;
              }
            }

            if (foundInSeason) {
              // Step 4: If cumulative position is beyond Season 1, fetch other seasons
              if (cumulativePos >= allRealEps.length && realSeasonUrls.length > 0) {
                for (const sUrl of realSeasonUrls) {
                  const { html: sHtml } = await fetchPage(sUrl);
                  if (!sHtml) continue;
                  const sEpRegex = /href="([^"]*\/episode\/[^"]+)"/gi;
                  while ((em = sEpRegex.exec(sHtml)) !== null) {
                    const epUrlStr = em[1];
                    if (!seenEps.has(epUrlStr)) {
                      seenEps.add(epUrlStr);
                      allRealEps.push(epUrlStr);
                    }
                  }
                  if (cumulativePos < allRealEps.length) break; // Optimization: Stop fetching if we reached the target index
                }
              }

              if (cumulativePos < allRealEps.length) {
                const realEpUrl = allRealEps[cumulativePos].startsWith('http')
                  ? allRealEps[cumulativePos]
                  : `${BASE_URL}${allRealEps[cumulativePos]}`;
                logger.info(`cross_series_redirect: ${epUrl} -> ${realEpUrl} (cumPos ${cumulativePos})`);
                return scrapeEpisodePlayer(realEpUrl, 1);
              }
            }
          }
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────────

    return servers;
  } catch (err) {
    return [];
  }
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'");
}

// Parse list of cards from ToonStream pages
function parseCardsFromHtml(html, isCartoon = false) {
  const cards = [];
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const artHtml = match[1];

    const imgMatch = artHtml.match(/<img[^>]+src="([^"]+)"/) || artHtml.match(/src="([^"]+)"/);
    if (!imgMatch) continue;
    let poster = imgMatch[1];
    if (poster && poster.startsWith('/')) {
      poster = `${BASE_URL}${poster}`;
    }

    const titleMatch = artHtml.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/i) ||
      artHtml.match(/alt="([^"]+)"/i);
    if (!titleMatch) continue;
    const title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());

    const hrefMatch = artHtml.match(/href="([^"]+)"[^>]*class="lnk-blk"/i) ||
      artHtml.match(/class="lnk-blk"[^>]*href="([^"]+)"/i) ||
      artHtml.match(/href="([^"]+)"/i);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1];

    const ratingMatch = artHtml.match(/<span class="vote">[\s\S]*?([\d.]+)/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 7.5;

    let type = 'tv';
    let slug = '';
    const parts = rawHref.split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1];

    if (rawHref.includes('/movies/')) {
      type = 'movie';
      slug = decodeHtmlEntities(lastPart);
    } else if (rawHref.includes('/series/')) {
      type = 'tv';
      slug = decodeHtmlEntities(lastPart);
    } else if (rawHref.includes('/episode/')) {
      type = 'tv';
      slug = decodeHtmlEntities(lastPart.replace(/-\d+x\d+$/, ''));
    } else {
      slug = decodeHtmlEntities(lastPart);
    }
    slug = slug.replace(/:/g, '').replace(/%3A/gi, '');

    const id = `toon_${slug}`;
    if (title.includes('${') || slug.includes('${') || poster.includes('${')) continue;

    cards.push({
      id,
      title,
      poster,
      rating: isNaN(rating) ? 7.5 : rating,
      vote_average: isNaN(rating) ? 7.5 : rating,
      type,
      slug,
      release_year: new Date().getFullYear(),
      original_language: isCartoon ? 'en' : 'ja' // Enforces Japanese-only front-end match
    });
  }

  const uniqueCards = [];
  const seenIds = new Set();
  for (const card of cards) {
    if (!seenIds.has(card.id)) {
      seenIds.add(card.id);
      uniqueCards.push(card);
    }
  }
  return uniqueCards;
}

// Fetch lists live
async function getLiveAnimeList(filter, page = 1, type = '', genre = '', query = '') {
  if (DISABLE_SCRAPING) return { results: [], page, total_pages: 1 };
  if (type === 'upcoming') {
    const now = Date.now();
    if (upcomingCache && (now - upcomingCacheTime < 1800000)) {
      return {
        results: upcomingCache,
        page: 1,
        total_pages: 1
      };
    }
  }

  let targetUrl = '';

  if (query) {
    targetUrl = `/s?q=${encodeURIComponent(query)}`;
  } else if (type === 'anime-movies') {
    targetUrl = `/category/anime?type=movies&page=${page}`;
  } else if (type === 'movie' || type === 'movies') {
    targetUrl = `/category/movies/?page=${page}`;
  } else if (type === 'cartoon-series' || type === 'cartoon') {
    targetUrl = `/category/cartoon/?page=${page}`;
  } else if (type === 'cartoon-movies') {
    targetUrl = `/category/cartoon?type=movies&page=${page}`;
  } else if (type === 'upcoming') {
    targetUrl = '/home';
  } else if (type === 'fresh-drop') {
    targetUrl = page === 1 ? '/home' : `/category/anime/?page=${page}`;
  } else {
    // Default to anime category (e.g. type === 'anime' or default)
    targetUrl = `/category/anime/?page=${page}`;
  }

  const { html, status } = await fetchPage(targetUrl);
  if (status === 404 || !html) return { results: [], page, total_pages: 1 };

  if (type === 'upcoming') {
    const match = html.match(/const\s+scheduleObj\s*=\s*(\{[\s\S]*?\});/);
    if (!match) return { results: [], page, total_pages: 1 };

    let scheduleObj = {};
    try {
      scheduleObj = JSON.parse(match[1]);
    } catch (e) {
      return { results: [], page, total_pages: 1 };
    }

    const uniqueTitles = new Set();
    const scheduleList = [];

    // Sort days of week starting from today
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayIndex = new Date().getDay();
    const orderedDays = [];
    for (let i = 0; i < 7; i++) {
      orderedDays.push(daysOfWeek[(todayIndex + i) % 7]);
    }

    const objKeys = Object.keys(scheduleObj);
    const dayMap = {};
    for (const key of objKeys) {
      dayMap[key.toLowerCase()] = key;
    }

    for (const dayName of orderedDays) {
      const actualKey = dayMap[dayName.toLowerCase()];
      if (actualKey && scheduleObj[actualKey]) {
        for (const item of scheduleObj[actualKey]) {
          if (!uniqueTitles.has(item.title)) {
            uniqueTitles.add(item.title);
            scheduleList.push({
              title: item.title,
              time: item.time,
              note: item.note,
              slug: slugify(item.title),
              day: actualKey
            });
          }
        }
      }
    }

    // Add any remaining keys in scheduleObj just in case
    for (const key of objKeys) {
      if (!orderedDays.map(d => d.toLowerCase()).includes(key.toLowerCase())) {
        for (const item of scheduleObj[key]) {
          if (!uniqueTitles.has(item.title)) {
            uniqueTitles.add(item.title);
            scheduleList.push({
              title: item.title,
              time: item.time,
              note: item.note,
              slug: slugify(item.title),
              day: key
            });
          }
        }
      }
    }

    // Try to enrich from MongoDB in a single batch query
    let animeCollection = null;
    let dbEntries = [];
    try {
      const { getCollection } = require('../db');
      animeCollection = getCollection('anime');
      if (animeCollection) {
        const titleRegexes = scheduleList.map(item => {
          const clean = item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(clean.replace(/\s+/g, '\\s*'), 'i');
        });
        const slugRegexes = scheduleList.map(item => {
          const clean = item.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = clean.replace(/-/g, '-?');
          // Removed the end anchor '$' to allow prefix matching in MongoDB query
          return new RegExp('^' + pattern, 'i');
        });

        dbEntries = await animeCollection.find({
          $or: [
            { title: { $in: titleRegexes } },
            { slug: { $in: slugRegexes } }
          ]
        }).toArray();
      }
    } catch (_) { }

    // Map for O(1) memory lookup
    const dbMap = new Map();
    const dbNormalizedMap = new Map();
    const normalize = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const entry of dbEntries) {
      if (entry.title) {
        dbMap.set(entry.title.toLowerCase(), entry);
        dbNormalizedMap.set(normalize(entry.title), entry);
      }
      if (entry.slug) {
        dbMap.set(entry.slug.toLowerCase(), entry);
        dbNormalizedMap.set(normalize(entry.slug), entry);
      }
    }

    const enrichedResults = [];
    for (const item of scheduleList) {
      let dbEntry = dbMap.get(item.title.toLowerCase()) ||
        dbMap.get(item.slug.toLowerCase()) ||
        dbNormalizedMap.get(normalize(item.title)) ||
        dbNormalizedMap.get(normalize(item.slug)) ||
        null;

      // Prefix/substring matching fallback
      if (!dbEntry) {
        const normTitle = normalize(item.title);
        const normSlug = normalize(item.slug);
        for (const [normKey, entry] of dbNormalizedMap.entries()) {
          if (normKey.startsWith(normTitle) || normKey.startsWith(normSlug) ||
            normTitle.startsWith(normKey) || normSlug.startsWith(normKey)) {
            dbEntry = entry;
            break;
          }
        }
      }

      const cleanTitleForSvg = item.title.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><rect width="500" height="750" fill="#181524"/><foreignObject x="40" y="40" width="420" height="670"><div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: center; justify-content: center; height: 100%; color: #e0e0e0; font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; font-weight: 700; font-size: 32px; text-align: center; word-break: break-word;">${cleanTitleForSvg}</div></foreignObject></svg>`;
      const placeholderPoster = `data:image/svg+xml;base64,${Buffer.from(svgString).toString('base64')}`;

      if (dbEntry) {
        enrichedResults.push({
          id: dbEntry.id || `toon_${item.slug}`,
          title: dbEntry.title || item.title,
          poster: dbEntry.poster || placeholderPoster,
          rating: dbEntry.rating || 7.5,
          vote_average: dbEntry.vote_average || 7.5,
          type: dbEntry.type || 'tv',
          slug: dbEntry.slug || item.slug,
          release_year: dbEntry.release_year || new Date().getFullYear(),
          original_language: 'ja',
          schedule_time: item.time,
          schedule_note: item.note,
          schedule_day: item.day
        });
      } else {
        enrichedResults.push({
          id: `toon_${item.slug}`,
          title: item.title,
          poster: placeholderPoster,
          rating: 7.5,
          vote_average: 7.5,
          type: 'tv',
          slug: item.slug,
          release_year: new Date().getFullYear(),
          original_language: 'ja',
          schedule_time: item.time,
          schedule_note: item.note,
          schedule_day: item.day
        });
      }
    }

    upcomingCache = enrichedResults;
    upcomingCacheTime = Date.now();

    return {
      results: enrichedResults,
      page: 1,
      total_pages: 1
    };
  }

  const isCartoon = type.startsWith('cartoon');
  const results = parseCardsFromHtml(html, isCartoon);

  if (type === 'fresh-drop') {
    if (page === 1) {
      const pageSize = 30;
      const paginatedResults = results.slice(0, pageSize);
      return {
        results: paginatedResults,
        page,
        total_pages: 50
      };
    } else {
      return {
        results,
        page,
        total_pages: results.length > 0 ? 50 : 1
      };
    }
  }

  return {
    results,
    page,
    total_pages: results.length > 0 ? 50 : 1
  };
}

// Fetch details live
async function getLiveAnimeDetails(id, slug, hintType = '') {
  if (DISABLE_SCRAPING) return null;
  const cleanSlug = slug || id.replace('toon_', '');
  const ultraCleanSlug = cleanSlug.replace(/[^a-zA-Z0-9-:]/g, '').replace(/--+/g, '-');

  const pathsToTry = [];
  const addPaths = (s) => {
    if (hintType === 'movie') {
      pathsToTry.push({ path: `/movies/${s}`, type: 'movie' });
      pathsToTry.push({ path: `/series/${s}`, type: 'tv' });
    } else {
      pathsToTry.push({ path: `/series/${s}`, type: 'tv' });
      pathsToTry.push({ path: `/movies/${s}`, type: 'movie' });
    }
  };
  addPaths(cleanSlug);
  if (ultraCleanSlug !== cleanSlug) {
    addPaths(ultraCleanSlug);
  }

  let html = '';
  let status = 404;
  let type = 'tv';
  let resolvedUrl = '';

  for (const t of pathsToTry) {
    const res = await fetchPage(t.path);
    if (res.status === 200 && res.html && res.html.includes('class="entry-title"')) {
      html = res.html;
      status = res.status;
      type = t.type;
      resolvedUrl = t.path;
      break;
    }
  }

  if (status !== 200 || !html) return null;

  // Parse details
  let title = '';
  const titleMatch = html.match(/<h1 class="entry-title">([\s\S]*?)<\/h1>/);
  if (titleMatch) title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());

  let description = 'No description available.';
  const descMatch = html.match(/<div class="description">([\s\S]*?)<\/div>/);
  if (descMatch) description = decodeHtmlEntities(descMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());

  let poster = '';
  const posterMatch = html.match(/class="post-thumbnail[^"]*"[\s\S]*?<img[^>]+src=["']([^"']+)["']/) || html.match(/class="post-thumbnail[^"]*"[\s\S]*?<img[^>]+src="([^"]+)"/);
  if (posterMatch) poster = posterMatch[1];
  if (poster && poster.startsWith('/')) {
    poster = `${BASE_URL}${poster}`;
  }

  let banner = poster;
  const bannerMatch = html.match(/<img[^>]+class="[^"]*TPostBg[^"]*"[^>]+src=["']([^"']+)["']/) || html.match(/<img[^>]+class="[^"]*TPostBg[^"]*"[^>]+src="([^"]+)"/);
  if (bannerMatch) banner = bannerMatch[1];
  if (banner && banner.startsWith('/')) {
    banner = `${BASE_URL}${banner}`;
  }

  let year = new Date().getFullYear();
  const yearMatch = html.match(/class="year[^"]*"[^>]*>(\d{4})<\/span>/) || html.match(/(\d{4})\b/);
  if (yearMatch) year = parseInt(yearMatch[1], 10);

  let rating = '7.5';
  const ratingMatch = html.match(/<span class="vote">\s*<span>TMDB<\/span>\s*([\d.]+)\s*<\/span>/);
  if (ratingMatch) rating = ratingMatch[1];

  // Extract genres
  let genres = [];
  const genresSpanMatch = html.match(/<span class="genres">([\s\S]*?)<\/span>/) || html.match(/Genres?:[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (genresSpanMatch) {
    const links = genresSpanMatch[1].match(/>([^<]+)</g) || [];
    genres = [...new Set(links.map(l => l.replace(/[><]/g, '').trim()).filter(g => g && g.length > 1 && !g.includes('/')))];
  }

  // Scrape player options immediately if it is a movie
  let movieSources = [];
  if (type === 'movie') {
    movieSources = await scrapeEpisodePlayer(resolvedUrl);
  }

  return {
    id: `toon_${cleanSlug}`,
    title,
    alternative_title: title,
    poster,
    banner,
    description,
    genres,
    type,
    release_year: year,
    rating: parseFloat(rating),
    vote_average: parseFloat(rating),
    original_language: 'ja',
    movieSources
  };
}

// Fetch episodes and player sources live
async function getLiveEpisodes(slug, targetSeason = 1, targetEpisode = 1) {
  if (DISABLE_SCRAPING) return [];
  let targetUrl = `/series/${slug}`;
  let { html, status } = await fetchPage(targetUrl);
  let resolvedSlug = slug; // track the real slug in case it has special chars (e.g. colon)

  const ultraCleanSlug = slug.replace(/[^a-zA-Z0-9-:]/g, '').replace(/--+/g, '-');
  if (status !== 200 && ultraCleanSlug !== slug) {
    targetUrl = `/series/${ultraCleanSlug}`;
    const res2 = await fetchPage(targetUrl);
    if (res2.status === 200 && res2.html && res2.html.includes('class="entry-title"')) {
      html = res2.html;
      status = res2.status;
      resolvedSlug = ultraCleanSlug;
      logger.info(`[SlugFix] Resolved via ultraCleanSlug: ${slug} -> ${ultraCleanSlug}`);
    }
  }

  // If /series/{slug} fails or returns 500 (e.g., slug has colon stripped by slugify),
  // find the real slug. Key insight: toon-stream.site slugs can contain colons (e.g., "jaadugar:-a-witch-in-mongolia")
  // but our slugify() strips them, so we need to discover the real slug.
  if (status !== 200) {
    // Strategy: Try the episode page by inserting a colon after a word boundary.
    // Toon-stream.site URLs use literal colons: /episode/jaadugar:-a-witch-in-mongolia-1x1/
    // We try inserting ":" before the first "-a-", "-the-", "-an-", "-in-", "-of-" to guess where title ends.
    const colonVariants = [];

    // Try inserting colon after each word (greedy - try all positions)
    const parts = slug.split('-');
    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(0, i).join('-') + ':-' + parts.slice(i).join('-');
      colonVariants.push(`/episode/${candidate}-${targetSeason}x${targetEpisode}/`);
    }
    // Also try the slug as-is (no colon)
    colonVariants.unshift(`/episode/${slug}-${targetSeason}x${targetEpisode}/`);

    let epPageRes = null;
    for (const epUrl of colonVariants) {
      const res = await fetchPage(epUrl);
      if (res.status === 200 && res.html && res.html.includes('entry-title')) {
        epPageRes = res;
        logger.info(`[SlugFix] Found working episode URL: ${epUrl}`);
        break;
      }
    }

    if (epPageRes) {
      // Extract real series slug from the episode page's breadcrumb links
      const seriesHrefMatch = epPageRes.html.match(/href="([^"]*\/series\/([^"/?#]+))[/"]/i);
      if (seriesHrefMatch) {
        resolvedSlug = decodeURIComponent(seriesHrefMatch[2]);
        const realSeriesRes = await fetchPage(`/series/${resolvedSlug}`);
        if (realSeriesRes.status === 200 && realSeriesRes.html && realSeriesRes.html.includes('entry-title')) {
          html = realSeriesRes.html;
          status = 200;
          logger.info(`[SlugFix] Resolved via colon-variant: ${slug} -> ${resolvedSlug}`);
        } else {
          // Use episode page HTML which has episode sidebar
          html = epPageRes.html;
          status = 200;
        }
      } else {
        html = epPageRes.html;
        status = 200;
      }
    }
  }

  // Fallback: Some animes on Toonstream do not have a /series/ page, only /episode/ pages.
  // Their episode pages still contain the full sidebar of all episodes.
  if (status !== 200 || !html) {
    const fallbackUrl = `/episode/${resolvedSlug}-1x1/`;
    const fbRes = await fetchPage(fallbackUrl);
    if (fbRes.status === 200 && fbRes.html) {
      html = fbRes.html;
      status = 200;
    } else {
      return [];
    }
  }

  // Helper to parse episodes from HTML
  const parseEpisodes = (content) => {
    const list = [];
    const epArticleRegex = /<article class="post dfx fcl episodes[^"]*">([\s\S]*?)<\/article>/gi;
    let epMatch;
    while ((epMatch = epArticleRegex.exec(content)) !== null) {
      const epHtml = epMatch[1];

      // Extract episode URL
      const urlMatch = epHtml.match(/href=["']([^"']+)["']/);
      if (!urlMatch) continue;
      const epUrl = decodeHtmlEntities(urlMatch[1]);

      // Extract title & image
      const titleMatch = epHtml.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/i);
      const imgMatch = epHtml.match(/<img[^>]+src=["']([^"']+)["']/i);

      // Extract season & episode numbers from URL (e.g. /episode/avatar-1x1/)
      const numMatch = epUrl.match(/(\d+)x(\d+)/);
      if (numMatch) {
        const s = parseInt(numMatch[1], 10);
        const e = parseInt(numMatch[2], 10);
        list.push({
          id: `ep_${slug}_${s}x${e}`,
          animeId: `toon_${slug}`,
          animeSlug: slug,
          season: s,
          episode: e,
          title: titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim()) : `S${s}E${e}`,
          url: epUrl,
          thumbnail: imgMatch ? imgMatch[1] : ''
        });
      }
    }
    return list;
  };

  const rawEpisodes = [];
  // Parse episodes from main page
  const mainEpisodes = parseEpisodes(html);
  rawEpisodes.push(...mainEpisodes);

  // Detect which season the main page actually showed
  // (some anime default to Season 0 / Specials on their main page)
  const mainPageSeasons = new Set(mainEpisodes.map(ep => ep.season));
  const mainPageShowedSeason1 = mainPageSeasons.has(1);

  // Find other season URLs
  const seasonUrls = [];
  const aTagRegex = /<a([\s\S]*?)>/gi;
  let aMatch;
  while ((aMatch = aTagRegex.exec(html)) !== null) {
    const attrs = aMatch[1];
    if (attrs.includes('season-btn')) {
      const urlMatch = attrs.match(/data-url=["']([^"']+)["']/);
      if (urlMatch) {
        let sUrl = decodeHtmlEntities(urlMatch[1]);
        if (!sUrl.startsWith('http')) sUrl = `${BASE_URL}${sUrl}`;
        // Skip the season the main page already showed; always fetch Season 1 if it wasn't on main page
        const alreadyParsed = [...mainPageSeasons].some(s => sUrl.endsWith(`/season/${s}`));
        if (!alreadyParsed && !seasonUrls.includes(sUrl)) {
          seasonUrls.push(sUrl);
        }
      }
    }
  }

  // If the main page showed Season 0 (or any non-1 season), make sure Season 1 is fetched
  if (!mainPageShowedSeason1 && !seasonUrls.some(u => u.endsWith('/season/1'))) {
    const season1Url = `${BASE_URL}/series/${slug}/season/1`;
    seasonUrls.unshift(season1Url); // fetch Season 1 first
  }

  // Fetch and parse other seasons in parallel to avoid timeouts
  const seasonResults = await Promise.all(
    seasonUrls.map(async (sUrl) => {
      try {
        const sRes = await fetchPage(sUrl);
        if (sRes.html) {
          return parseEpisodes(sRes.html);
        }
      } catch (err) {
        logger.error(`Live: failed to fetch season: ${sUrl}`, err);
      }
      return [];
    })
  );

  for (const sEpisodes of seasonResults) {
    rawEpisodes.push(...sEpisodes);
  }

  // Filter out Season 0 (Specials) — they break the Season 1 selector
  const filteredEpisodes = rawEpisodes.filter(ep => ep.season > 0);

  // Sort episodes: season ascending, episode ascending
  filteredEpisodes.sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    return a.episode - b.episode;
  });

  // Deduplicate by season+episode key (in case main page and season/1 URL overlap)
  const seen = new Set();
  const deduped = filteredEpisodes.filter(ep => {
    const key = `${ep.season}x${ep.episode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Only scrape play sources for the requested season/episode to be 20x-30x faster!
  await Promise.all(deduped.map(async (ep) => {
    if (ep.season === targetSeason && ep.episode === targetEpisode) {
      let sources = await scrapeEpisodePlayer(ep.url);

      const hasPlayServer = sources.some(s => s.label && s.label.toLowerCase() === 'play');
      if (sources.length === 0 || !hasPlayServer) {
        logger.info(`no_play_server_on_toonstream_trying_fallback_site_for_${slug}`);
        const fallbackSources = await getPlayServerFromFallback(slug, targetSeason, targetEpisode);
        if (fallbackSources && fallbackSources.length > 0) {
          if (sources.length === 0) {
            sources = fallbackSources;
          } else {
            const fallbackPlay = fallbackSources.filter(s => s.label && s.label.toLowerCase() === 'play');
            sources.push(...fallbackPlay);
          }
        }
      }

      ep.sources = sources;
    } else {
      ep.sources = [];
    }
  }));

  return deduped;
}

// Fallback scraper for watchanimeworld.net when toon-stream.site lacks servers or the Play server
async function getPlayServerFromFallback(animeSlug, season, episode) {
  try {
    const fallbackBase = 'https://watchanimeworld.net';
    const epUrl = `${fallbackBase}/episode/${animeSlug}-${season}x${episode}/`;

    // Fetch using watchanimeworld URL
    const { html } = await fetchPage(epUrl);
    if (!html) return [];

    const tabMap = {};
    const tabRegex = /<span\s+tab="(ln\d+)"[^>]*>([\s\S]*?)<\/span>/gi;
    let tabMatch;
    while ((tabMatch = tabRegex.exec(html)) !== null) {
      tabMap[tabMatch[1]] = tabMatch[2].replace(/<[^>]*>/g, '').trim();
    }

    const embedMap = {};
    const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:\bsrc\b|\bdata-src\b)="([^"]+)"/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `${fallbackBase}${embedUrl}`;
      if (!embedMap[optMatch[1]]) {
        embedMap[optMatch[1]] = embedUrl;
      }
    }

    const servers = [];
    const blockRegex = /id="(ln\d+)"\s+class="lrt[^"]*">([\s\S]*?)<\/div>/gi;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(html)) !== null) {
      const tabId = blockMatch[1];
      const blockHtml = blockMatch[2];
      const language = tabMap[tabId] || 'Multi Audio';

      const liRegex = /<li>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRegex.exec(blockHtml)) !== null) {
        const liHtml = liMatch[1];
        const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
        const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
        if (hrefMatch && nameMatch) {
          const optionId = hrefMatch[1];
          const serverName = nameMatch[1].trim();
          const embedUrl = embedMap[optionId];
          if (embedUrl) {
            if (
              embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
              embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
              embedUrl.includes('youtube.com')
            ) continue;

            servers.push({
              url: embedUrl,
              type: 'iframe',
              label: serverName,
              language: language
            });
          }
        }
      }
    }

    if (servers.length === 0) {
      const serverMap = {};
      const liRegex = /<li>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRegex.exec(html)) !== null) {
        const liHtml = liMatch[1];
        const hrefMatch = liHtml.match(/href="#(options-\d+)"/);
        const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
        if (hrefMatch && nameMatch) {
          serverMap[hrefMatch[1]] = nameMatch[1].trim();
        }
      }
      for (const [optId, embedUrl] of Object.entries(embedMap)) {
        if (
          embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
          embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
          embedUrl.includes('youtube.com')
        ) continue;
        const label = serverMap[optId] || 'Server';
        servers.push({ url: embedUrl, type: 'iframe', label, language: 'Multi Audio' });
      }
    }

    return servers;
  } catch (err) {
    logger.error(`Fallback: failed to parse play server from watchanimeworld: ${animeSlug}`, err);
    return [];
  }
}

module.exports = {
  getLiveAnimeList,
  getLiveAnimeDetails,
  getLiveEpisodes,
  getPlayServerFromFallback
};
