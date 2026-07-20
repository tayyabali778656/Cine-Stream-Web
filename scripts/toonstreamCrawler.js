'use strict';

const https = require('https');
const { connectDB, getCollection } = require('../db');
const logger = require('../utils/logger');

const config = require('../config');
const BASE_URL = config.toonstreamBaseUrl || 'https://toon-stream.site';

// ── HTTP Helper ────────────────────────────────────────────────────────────────
function fetchPage(url, retries = 3) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': BASE_URL,
        },
        timeout: 20000,
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
        if (n > 0) {
          logger.info(`retrying_fetch: ${fullUrl} (${n} left)`);
          setTimeout(() => attempt(n - 1), 2000);
        } else {
          reject(err);
        }
      }).on('timeout', function () {
        this.destroy();
        if (n > 0) {
          logger.info(`timeout_retry: ${fullUrl}`);
          setTimeout(() => attempt(n - 1), 3000);
        } else {
          reject(new Error(`Timeout: ${fullUrl}`));
        }
      });
    };
    attempt(retries);
  });
}

// ── Sleep Helper ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Regex Extractors ───────────────────────────────────────────────────────────
function extractTitle(html) {
  // Try h1.entry-title first (detail page)
  let m = html.match(/<h1 class="entry-title">([\s\S]*?)<\/h1>/);
  if (m) return m[1].replace(/<[^>]*>/g, '').trim();
  // Fallback: og:title
  m = html.match(/<meta property="og:title" content="([^"]+)"/);
  return m ? m[1].replace(/ - ToonStream.*$/i, '').trim() : '';
}

function extractDescription(html) {
  // Try .description div
  let m = html.match(/<div class="description">([\s\S]*?)<\/div>/);
  if (m) return m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 1000);
  // Fallback: og:description
  m = html.match(/<meta property="og:description" content="([^"]+)"/);
  return m ? m[1].trim() : '';
}

function extractPoster(html) {
  // post-thumbnail contains the poster
  let m = html.match(/class="post-thumbnail[^"]*"[\s\S]*?<img[^>]+src="([^"]+)"/);
  let src = '';
  if (m) src = m[1];
  else {
    m = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (m) src = m[1];
  }
  if (src && src.startsWith('/')) {
    src = `${BASE_URL}${src}`;
  }
  return src;
}

function extractBanner(html) {
  // TPostBg or background image
  let m = html.match(/<img[^>]+class="[^"]*TPostBg[^"]*"[^>]+src="([^"]+)"/);
  let src = '';
  if (m) src = m[1];
  else {
    m = html.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/);
    if (m) src = m[1];
  }
  if (src && src.startsWith('/')) {
    src = `${BASE_URL}${src}`;
  }
  return src;
}

function extractGenres(html) {
  // .genres span
  let m = html.match(/<span class="genres">([\s\S]*?)<\/span>/);
  if (!m) m = html.match(/Genres?:[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  if (!m) return [];
  const links = m[1].match(/>([^<]+)</g) || [];
  return [...new Set(links.map(l => l.replace(/[><]/g, '').trim()).filter(g => g && g.length > 1 && !g.includes('/')))];
}

function extractYear(html) {
  let m = html.match(/class="year[^"]*"[^>]*>(\d{4})<\/span>/);
  if (m) return parseInt(m[1], 10);
  // Try release date pattern
  m = html.match(/(\d{4})\b/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

function extractRating(html) {
  // TMDB vote
  let m = html.match(/<span class="vote">\s*<span>TMDB<\/span>\s*([\d.]+)\s*<\/span>/);
  if (m) return m[1];
  // Any number between 1-10
  m = html.match(/(?:Rating|IMDb|TMDB)[^>]*>\s*([\d.]+)\s*\//i);
  return m ? m[1] : '7.5';
}

function extractDuration(html) {
  const m = html.match(/class="duration[^"]*"[^>]*>([^<]+)<\/span>/);
  return m ? m[1].trim() : '';
}

function extractLanguage(html) {
  const m = html.match(/Language:[\s\S]*?<\/(?:span|p|li)>/i);
  if (!m) return 'Hindi / English';
  return m[0].replace(/<[^>]*>/g, '').replace('Language:', '').trim().substring(0, 100);
}

function extractStatus(html) {
  const m = html.match(/Status:[\s\S]*?<\/(?:span|p|li)>/i);
  if (!m) return 'Completed';
  return m[0].replace(/<[^>]*>/g, '').replace('Status:', '').trim() || 'Completed';
}

async function scrapeEpisodePlayer(epUrl) {
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
      const nameMatch = liHtml.match(/<span class="server">([\s\S]*?)<\/span>/);
      const numMatch = liHtml.match(/<span>\s*(\d+)\s*<\/span>/);
      if (hrefMatch && nameMatch) {
        const optionId = hrefMatch[1];
        const serverName = nameMatch[1].trim();
        const serverNum = numMatch ? parseInt(numMatch[1].trim(), 10) : Object.keys(serverMap).length + 1;
        serverMap[optionId] = { name: serverName, num: serverNum };
      }
    }

    // Step 2: Parse all option divs and map options-N -> embed URL (supports both src and data-src)
    const embedMap = {}; // 'options-0' -> 'https://toon-stream.site/embed/xxx'
    const optionDivRegex = /id="(options-\d+)"[\s\S]*?(?:\bsrc\b|\bdata-src\b)="([^"]+)"/gi;
    let optMatch;
    while ((optMatch = optionDivRegex.exec(html)) !== null) {
      let embedUrl = optMatch[2];
      if (embedUrl.startsWith('/')) embedUrl = `${BASE_URL}${embedUrl}`;
      if (!embedMap[optMatch[1]]) {
        embedMap[optMatch[1]] = embedUrl;
      }
    }

    // Step 3: Build final server list using real names if available, fallback to position
    const servers = [];
    const optionIds = Object.keys(embedMap).sort((a, b) => {
      const na = parseInt(a.replace('options-', ''), 10);
      const nb = parseInt(b.replace('options-', ''), 10);
      return na - nb;
    });

    for (const optId of optionIds) {
      const embedUrl = embedMap[optId];
      // Filter out tracking/ads iframes
      if (
        embedUrl.includes('google') || embedUrl.includes('doubleclick') ||
        embedUrl.includes('facebook') || embedUrl.includes('analytics') ||
        embedUrl.includes('youtube.com')
      ) continue;

      const serverInfo = serverMap[optId];
      const label = serverInfo
        ? `${serverInfo.name}`  // Use ToonStream's real name: Ruby, cloudy, Moly...
        : `Server ${servers.length + 1}`; // Fallback if not in switcher list

      servers.push({ url: embedUrl, type: 'iframe', label });
    }

    return servers;
  } catch (err) {
    return [];
  }
}

// ── Scrape Detail Page ─────────────────────────────────────────────────────────
async function scrapeDetailPage(url, type) {
  try {
    const { html, status } = await fetchPage(url);
    if (!html || status === 404) return null;

    const title = extractTitle(html);
    if (!title) return null;

    const poster = extractPoster(html);
    const banner = extractBanner(html) || poster;
    const description = extractDescription(html);
    const genres = extractGenres(html);
    const year = extractYear(html);
    const rating = extractRating(html);
    const duration = extractDuration(html);
    const language = extractLanguage(html);
    const status_str = extractStatus(html);

    // Slug from URL
    const slug = url.split('/').filter(Boolean).pop().split('?')[0];

    // Helper to parse episodes from HTML
    const parseEpisodesFromHtml = (content) => {
      const list = [];
      const epArticleRegex = /<article class="post dfx fcl episodes[^"]*">([\s\S]*?)<\/article>/gi;
      let match;
      while ((match = epArticleRegex.exec(content)) !== null) {
        const epHtml = match[1];
        const numMatch = epHtml.match(/<span class="num-epi">\s*(\d+x\d+)\s*<\/span>/i);
        const hrefMatch = epHtml.match(/href="([^"]+)"/);
        const titleMatch = epHtml.match(/<h5 class="entry-title1"[^>]*>([\s\S]*?)<\/h5>/i);
        const imgMatch = epHtml.match(/src="([^"]+)"/);

        if (hrefMatch && numMatch) {
          const epNumStr = numMatch[1].trim();
          const [s, e] = epNumStr.split('x').map(n => parseInt(n, 10));
          const epUrl = hrefMatch[1].startsWith('http') ? hrefMatch[1] : `${BASE_URL}${hrefMatch[1]}`;
          list.push({
            episodeNum: e,
            seasonNum: s,
            title: titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : `S${s}E${e}`,
            url: epUrl,
            thumbnail: imgMatch ? imgMatch[1] : ''
          });
        }
      }
      return list;
    };

    const rawEpisodes = [];
    // Parse first/main season episodes
    const mainEpisodes = parseEpisodesFromHtml(html);
    rawEpisodes.push(...mainEpisodes);

    // Find other season URLs
    const seasonUrls = [];
    const aTagRegex = /<a([\s\S]*?)>/gi;
    let aMatch;
    while ((aMatch = aTagRegex.exec(html)) !== null) {
      const attrs = aMatch[1];
      if (attrs.includes('season-btn')) {
        const urlMatch = attrs.match(/data-url="([^"]+)"/);
        if (urlMatch) {
          let sUrl = urlMatch[1];
          if (!sUrl.startsWith('http')) sUrl = `${BASE_URL}${sUrl}`;
          // Skip Season 1 since we already parsed it from the main page
          if (!sUrl.endsWith('/season/1') && !seasonUrls.includes(sUrl)) {
            seasonUrls.push(sUrl);
          }
        }
      }
    }

    // Fetch and parse other seasons
    for (const sUrl of seasonUrls) {
      try {
        logger.info(`crawling_season_subpage: ${sUrl} for ${slug}`);
        const sRes = await fetchPage(sUrl);
        if (sRes.html) {
          const sEpisodes = parseEpisodesFromHtml(sRes.html);
          rawEpisodes.push(...sEpisodes);
          logger.info(`parsed_${sEpisodes.length}_episodes_from_season: ${sUrl}`);
        }
        await sleep(300); // polite delay between seasons
      } catch (err) {
        logger.error(`failed_to_scrape_season: ${sUrl}`, err);
      }
    }

    rawEpisodes.sort((a, b) => {
      if (a.seasonNum !== b.seasonNum) return a.seasonNum - b.seasonNum;
      return a.episodeNum - b.episodeNum;
    });

    const id = `toon_${slug}`;
    const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;

    return {
      anime: {
        id,
        title,
        alternative_title: title,
        poster,
        banner,
        description,
        genres,
        type,
        status: status_str,
        seasonCount: [...new Set(rawEpisodes.map(ep => ep.seasonNum))].length || 1,
        episodeCount: rawEpisodes.length,
        release_year: year,
        rating,
        duration,
        language,
        tags: [...new Set([...genres, type, status_str])],
        slug,
        watch_page_url: fullUrl,
        updatedAt: new Date()
      },
      episodes: rawEpisodes.map(ep => ({
        id: `ep_${slug}_${ep.seasonNum}x${ep.episodeNum}`,
        animeId: id,
        animeSlug: slug,
        season: ep.seasonNum,
        episode: ep.episodeNum,
        title: ep.title,
        url: ep.url,
        thumbnail: ep.thumbnail
      }))
    };
  } catch (err) {
    logger.error(`failed_to_scrape_detail: ${url}`, err);
    return null;
  }
}

// ── Scrape Category Pages ──────────────────────────────────────────────────────
async function scrapeCategory(category, type) {
  const animeCol = getCollection('anime');
  const episodesCol = getCollection('episodes');
  const genresCol = getCollection('genres');

  let page = 1;
  let totalSaved = 0;
  const forceCrawl = process.argv.includes('--force');

  logger.info(`starting_category_crawl: ${category} (type=${type})`);

  while (true) {
    // CORRECT URL FORMAT: /category/anime/?page=N  (no type=all)
    const url = `/category/${category}/?page=${page}`;
    logger.info(`crawling_category_page: ${url}`);

    try {
      const { html, status } = await fetchPage(url);
      if (status === 404 || !html || html.length < 500) {
        logger.info(`category_end: ${category} at page ${page}`);
        break;
      }

      // Extract links: /series/slug or /movies/slug (these are rendered in HTML as href="/series/..." or href="https://toon-stream.site/series/...")
      const detailLinkRegex = /href="((?:https:\/\/(?:toonstream\.vip|toon-stream\.site))?\/(?:series|movies)\/([^"/?#]+))"/g;
      let match;
      const detailLinks = [];
      const seen = new Set();
      while ((match = detailLinkRegex.exec(html)) !== null) {
        const path = match[1].startsWith('http') ? match[1] : `${BASE_URL}${match[1]}`;
        if (!seen.has(path)) {
          seen.add(path);
          detailLinks.push(path);
        }
      }

      if (detailLinks.length === 0) {
        logger.info(`no_links_found_on_page: ${url} — stopping category`);
        break;
      }

      logger.info(`found_${detailLinks.length}_links_on_page_${page}: ${category}`);

      for (const detailUrl of detailLinks) {
        try {
          const slug = detailUrl.split('/').filter(Boolean).pop();
          const id = `toon_${slug}`;

          // Skip if recently updated (unless force)
          if (!forceCrawl) {
            const existing = await animeCol.findOne({ id });
            if (existing && (Date.now() - new Date(existing.updatedAt).getTime()) < 24 * 60 * 60 * 1000) {
              logger.info(`skip_recent: ${slug}`);
              continue;
            }
          }

          const result = await scrapeDetailPage(detailUrl, type);
          if (!result) continue;

          await animeCol.updateOne({ id: result.anime.id }, { $set: result.anime }, { upsert: true });

          // Save episodes + scrape player sources in parallel batches to speed up crawl
          const episodes = result.episodes;
          const concurrency = 8;
          for (let i = 0; i < episodes.length; i += concurrency) {
            const batch = episodes.slice(i, i + concurrency);
            await Promise.all(batch.map(async (ep) => {
              const playerSources = await scrapeEpisodePlayer(ep.url);
              ep.sources = playerSources;
              await episodesCol.updateOne({ id: ep.id }, { $set: ep }, { upsert: true });
            }));
          }

          // Save genres
          for (const genre of result.anime.genres) {
            await genresCol.updateOne({ name: genre }, { $set: { name: genre } }, { upsert: true });
          }

          totalSaved++;
          logger.info(`saved_anime: ${result.anime.title} | eps:${result.episodes.length} | total:${totalSaved}`);

          // Polite delay
          await sleep(300);
        } catch (err) {
          logger.error(`detail_error: ${detailUrl}`, err);
        }
      }

      page++;
      await sleep(500); // polite page delay
    } catch (err) {
      logger.error(`category_crawl_error: ${url}`, err);
      break;
    }
  }

  logger.info(`category_done: ${category} | total_saved: ${totalSaved}`);
}

// ── Scrape Homepage Lists ──────────────────────────────────────────────────────
async function scrapeHomepage() {
  logger.info('starting_homepage_crawl');
  try {
    const { html } = await fetchPage('/home');
    if (!html) return;

    const featuredCol = getCollection('featured');
    const latestCol = getCollection('latest');
    const popularCol = getCollection('popular');

    // Clear old lists
    await featuredCol.deleteMany({});
    await latestCol.deleteMany({});
    await popularCol.deleteMany({});

    // Parse sections by looking for section headings and associated article links
    const sectionRegex = /<section[^>]*>([\s\S]*?)<\/section>/g;
    let sMatch;
    let popular = [], latest = [], featured = [];

    while ((sMatch = sectionRegex.exec(html)) !== null) {
      const sHtml = sMatch[1];
      const titleMatch = sHtml.match(/class="section-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/);
      if (!titleMatch) continue;

      const title = titleMatch[1].replace(/<[^>]*>/g, '').trim().toLowerCase();

      // Extract all /series/ and /movies/ links from this section
      const linkRegex = /href="((?:https:\/\/(?:toonstream\.vip|toon-stream\.site))?\/(?:series|movies)\/([^"/?#]+))"/g;
      let lMatch;
      const ids = [];
      while ((lMatch = linkRegex.exec(sHtml)) !== null) {
        const slug = lMatch[2];
        ids.push(`toon_${slug}`);
      }

      logger.info(`homepage_section: "${title}" | links: ${ids.length}`);

      if (title.includes('fresh') || title.includes('latest') || title.includes('new')) {
        latest.push(...ids);
      } else if (title.includes('featured') || title.includes('random')) {
        featured.push(...ids);
      } else if (title.includes('trend') || title.includes('popular') || title.includes('top')) {
        popular.push(...ids);
      } else {
        // Default: add to popular
        popular.push(...ids);
      }
    }

    // Deduplicate
    const uniquePopular = [...new Set(popular)];
    const uniqueLatest = [...new Set(latest)];
    const uniqueFeatured = [...new Set(featured)];

    if (uniquePopular.length > 0) await popularCol.insertMany(uniquePopular.map(id => ({ animeId: id })));
    if (uniqueLatest.length > 0) await latestCol.insertMany(uniqueLatest.map(id => ({ animeId: id })));
    if (uniqueFeatured.length > 0) await featuredCol.insertMany(uniqueFeatured.map(id => ({ animeId: id })));

    logger.info(`homepage_done: popular:${uniquePopular.length} latest:${uniqueLatest.length} featured:${uniqueFeatured.length}`);

    // If all lists are empty (JS-rendered homepage), scrape category page 1 as fallback for popular
    if (uniquePopular.length === 0) {
      logger.info('homepage_lists_empty_using_category_fallback');
      const { html: catHtml } = await fetchPage('/category/anime/?page=1');
      const linkRegex = /href="((?:https:\/\/(?:toonstream\.vip|toon-stream\.site))?\/(?:series|movies)\/([^"/?#]+))"/g;
      let lMatch;
      const fallbackIds = [];
      while ((lMatch = linkRegex.exec(catHtml)) !== null) {
        fallbackIds.push(`toon_${lMatch[2]}`);
      }
      const uniq = [...new Set(fallbackIds)];
      if (uniq.length > 0) {
        await popularCol.insertMany(uniq.map(id => ({ animeId: id })));
        logger.info(`fallback_popular_set: ${uniq.length} items`);
      }
    }
  } catch (err) {
    logger.error('homepage_crawl_failed', err);
  }
}

// ── Build Search Index ─────────────────────────────────────────────────────────
async function buildSearchIndex() {
  logger.info('building_search_index');
  try {
    const animeCol = getCollection('anime');
    const indexCol = getCollection('searchIndex');
    const items = await animeCol.find({}).toArray();

    logger.info(`search_index_items_count: ${items.length}`);
    await indexCol.deleteMany({});
    if (items.length > 0) {
      await indexCol.insertMany(items.map(item => ({
        id: item.id,
        title: item.title,
        alternative_title: item.alternative_title || '',
        description: (item.description || '').substring(0, 500),
        genres: item.genres,
        type: item.type,
        rating: item.rating,
        release_year: item.release_year,
        poster: item.poster,
        slug: item.slug
      })));
    }
    logger.info('search_index_rebuilt');
  } catch (err) {
    logger.error('search_index_failed', err);
  }
}

// ── Scrape Details of all Homepage Items ──────────────────────────────────────
async function scrapeHomepageDetails() {
  logger.info('starting_homepage_details_crawl');
  const popularCol = getCollection('popular');
  const latestCol = getCollection('latest');
  const featuredCol = getCollection('featured');
  const animeCol = getCollection('anime');
  const episodesCol = getCollection('episodes');
  const genresCol = getCollection('genres');

  const popular = await popularCol.find({}).toArray();
  const latest = await latestCol.find({}).toArray();
  const featured = await featuredCol.find({}).toArray();

  const allIds = [...new Set([
    ...popular.map(p => p.animeId),
    ...latest.map(l => l.animeId),
    ...featured.map(f => f.animeId)
  ])];

  logger.info(`found_${allIds.length}_unique_homepage_ids_to_scrape`);

  for (const id of allIds) {
    try {
      const slug = id.replace('toon_', '');
      const detailUrl = `/series/${slug}`;

      // Skip if recently updated (unless force)
      const forceCrawl = process.argv.includes('--force');
      if (!forceCrawl) {
        const existing = await animeCol.findOne({ id });
        if (existing && (Date.now() - new Date(existing.updatedAt).getTime()) < 24 * 60 * 60 * 1000) {
          logger.info(`skip_recent_homepage_item: ${slug}`);
          continue;
        }
      }

      logger.info(`crawling_homepage_item: ${detailUrl}`);
      const result = await scrapeDetailPage(detailUrl, 'series');
      if (!result) continue;

      await animeCol.updateOne({ id: result.anime.id }, { $set: result.anime }, { upsert: true });

      // Save episodes + scrape player sources in parallel batches to speed up crawl
      const episodes = result.episodes;
      const concurrency = 8;
      for (let i = 0; i < episodes.length; i += concurrency) {
        const batch = episodes.slice(i, i + concurrency);
        await Promise.all(batch.map(async (ep) => {
          const playerSources = await scrapeEpisodePlayer(ep.url);
          ep.sources = playerSources;
          await episodesCol.updateOne({ id: ep.id }, { $set: ep }, { upsert: true });
        }));
      }

      for (const genre of result.anime.genres) {
        await genresCol.updateOne({ name: genre }, { $set: { name: genre } }, { upsert: true });
      }

      logger.info(`saved_homepage_anime: ${result.anime.title} | eps: ${result.episodes.length}`);
      await sleep(200);
    } catch (err) {
      logger.error(`failed_to_scrape_homepage_details_for_id: ${id}`, err);
    }
  }
}

// ── Also seed popular list from DB if empty ────────────────────────────────────
async function seedPopularFromDB() {
  const popularCol = getCollection('popular');
  const animeCol = getCollection('anime');
  const count = await popularCol.countDocuments();
  if (count === 0) {
    logger.info('popular_empty_seeding_from_anime_collection');
    const items = await animeCol.find({}).sort({ updatedAt: -1 }).limit(100).toArray();
    if (items.length > 0) {
      await popularCol.insertMany(items.map(i => ({ animeId: i.id })));
      logger.info(`popular_seeded: ${items.length}`);
    }
  }
}

// ── Main Crawl ─────────────────────────────────────────────────────────────────
async function run() {
  const start = Date.now();
  try {
    await connectDB();
    logger.info('toonstream_crawler_started');

    // Step 1: Scrape homepage lists for trending/popular sections
    await scrapeHomepage();

    // Step 1.5: Deep crawl all details of homepage items (ensures homepage matches completely and plays)
    await scrapeHomepageDetails();

    // Step 2: Scrape all category pages for full data
    await scrapeCategory('anime', 'series');
    await scrapeCategory('cartoon', 'series');
    await scrapeCategory('movies', 'movie');

    // Step 3: Seed popular if still empty
    await seedPopularFromDB();

    // Step 4: Rebuild search index
    await buildSearchIndex();

    logger.info('toonstream_crawler_finished', { duration_ms: Date.now() - start });
    process.exit(0);
  } catch (err) {
    logger.error('toonstream_crawler_fatal', err);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
