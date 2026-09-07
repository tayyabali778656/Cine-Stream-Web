'use strict';

const https = require('https');
const logger = require('../utils/logger');

const BASE_URL = 'https://animekai.be';

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

// Helper to fetch HTML content from AnimeKai
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

async function searchAnime(keyword, page = 1) {
  try {
    const url = `/browse?keyword=${encodeURIComponent(keyword)}&page=${page}`;
    const { html } = await fetchPage(url);
    if (!html) return { results: [], page: 1, total_pages: 1 };

    const results = [];
    // Basic regex parsing for .aitem blocks
    const itemRegex = /<div class="aitem">([\s\S]*?)<\/div>\s*<\/div>/gi;
    let match;

    while ((match = itemRegex.exec(html)) !== null) {
      const itemHtml = match[1];

      // Extract href/slug
      const hrefMatch = itemHtml.match(/<a class="title" href="[^"]*\/watch\/([^"]+)"/);
      if (!hrefMatch) continue;
      const slug = hrefMatch[1];

      // Extract title
      const titleMatch = itemHtml.match(/<a class="title"[^>]*title="([^"]+)"/);
      let title = titleMatch ? titleMatch[1] : slug;
      
      // decode HTML entities
      title = title.replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

      // Extract Romaji/JP title
      const jpMatch = itemHtml.match(/data-jp="([^"]*)"/);
      const romaji = jpMatch ? jpMatch[1] : title;

      // Extract image
      const imgMatch = itemHtml.match(/<img src="([^"]+)"/);
      const poster = imgMatch ? imgMatch[1] : '';

      // Extract sub/dub
      const subMatch = itemHtml.match(/<span class="sub">.*?<\/svg>(\d+)/);
      const dubMatch = itemHtml.match(/<span class="dub">.*?<\/svg>(\d+)/);
      const sub = subMatch ? parseInt(subMatch[1]) : 0;
      const dub = dubMatch ? parseInt(dubMatch[1]) : 0;
      
      // Extract Type
      const typeMatch = itemHtml.match(/<span><b>(TV|Movie|OVA|ONA|Special)<\/b><\/span>/i);
      const type = typeMatch ? typeMatch[1] : 'TV';

      results.push({
        id: `animekai_${slug}`, // Prefix to route correctly in details
        slug: slug,
        title: title,
        romaji: romaji,
        poster: poster,
        type: type,
        sub: sub,
        dub: dub,
        rating: 0,
        source: 'animekai'
      });
    }

    return { results, page: 1, total_pages: 1 };
  } catch (err) {
    logger.warn('AnimeKai search failed:', err.message);
    return { results: [], page: 1, total_pages: 1 };
  }
}

async function getAnimeDetails(slug) {
  try {
    let cleanSlug = slug.replace(/^animekai_/, '');
    let { html, status } = await fetchPage(`/watch/${cleanSlug}`);
    if (!html || status === 404) return null;

    // AnimeKai redirects /watch/slug to the first episode via a meta refresh.
    const refreshMatch = html.match(/url='([^']+)'/i);
    if (refreshMatch) {
       let redirectUrl = refreshMatch[1].replace(/^https?:\/\/[^\/]+/, '');
       const nextResp = await fetchPage(redirectUrl);
       html = nextResp.html;
       status = nextResp.status;
       if (!html || status === 404) return null;
    }

    const titleMatch = html.match(/<h2 class="title"[^>]*>([^<]+)<\/h2>/i) || html.match(/<h1 class="title"[^>]*>([^<]+)<\/h1>/i);
    let title = titleMatch ? titleMatch[1].trim() : cleanSlug;
    title = title.replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

    const descMatch = html.match(/<div class="desc text-expand"[^>]*>([\s\S]*?)(?:<\/div>|<!--)/i);
    let description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const posterMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';

    const dateMatch = html.match(/Date aired: <span>\s*([\s\S]*?)\s*<\/span>/i);
    let release_year = '';
    if (dateMatch) {
       const yearMatch = dateMatch[1].match(/\d{4}/);
       if (yearMatch) release_year = yearMatch[0];
    }

    const animeId = `animekai_${cleanSlug}`;

    // Note: AnimeKai episode list is embedded in the page, but since we use ToonStream format,
    // we just return standard details and let getLiveEpisodes fetch them later.
    return {
      id: animeId,
      slug: cleanSlug,
      title: title,
      romaji: title,
      description: description,
      poster: poster,
      cover: poster,
      type: 'TV',
      season: 1,
      release_year: release_year,
      rating: 0,
      sub: 0,
      dub: 0,
      genres: [],
      source: 'animekai'
    };
  } catch (err) {
    logger.warn(`AnimeKai getDetails failed for ${slug}:`, err.message);
    return null;
  }
}

async function getLiveEpisodes(slug, season, episode) {
  try {
    // Clean animekai_ prefix and toonstream suffixes if accidentally passed
    let cleanSlug = slug.replace(/^animekai_/, '');
    cleanSlug = cleanSlug
      .replace(/-eng-jap$/i, '')
      .replace(/-eng$/i, '')
      .replace(/-jap$/i, '')
      .replace(/-dub-sub$/i, '')
      .replace(/-dub$/i, '')
      .replace(/-sub$/i, '');
    
    // AnimeKai usually separates seasons with -season-X in the slug.
    let targetUrl;
    let html, status;
    
    if (season > 1) {
      targetUrl = `/watch/${cleanSlug}-season-${season}/ep-${episode}`;
      const sResult = await fetchPage(targetUrl);
      html = sResult.html;
      status = sResult.status;
      if (status === 200) {
          cleanSlug = `${cleanSlug}-season-${season}`;
      }
    }
    
    // Fallback: If season === 1, try the base slug
    if ((!html || status === 404) && season === 1) {
      targetUrl = `/watch/${cleanSlug}/ep-${episode}`;
      const sResult = await fetchPage(targetUrl);
      html = sResult.html;
      status = sResult.status;
    }
    
    // Fallback: If 404, maybe it's a movie and just /watch/{slug} has the player
    // Only do this for season 1, otherwise we falsely fetch season 1 for missing higher seasons
    if ((!html || status === 404) && season === 1) {
        targetUrl = `/watch/${cleanSlug}`;
        const fallback = await fetchPage(targetUrl);
        html = fallback.html;
        status = fallback.status;
    }
    
    // Advanced Fallback: Search AnimeKai to find the real slug (useful for Misfit of Demon King Academy, etc.)
    if (!html || status === 404) {
        try {
            const searchQuery = cleanSlug.replace(/-/g, ' ');
            const searchResults = await module.exports.searchAnime(searchQuery);
            if (searchResults && searchResults.results && searchResults.results.length > 0) {
                let bestMatch = null;
                if (season === 1) {
                    bestMatch = searchResults.results.find(r => r.slug === cleanSlug) || searchResults.results[0];
                } else {
                    const romanNumerals = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
                    const seasonRoman = romanNumerals[season];
                    
                    bestMatch = searchResults.results.find(r => 
                        r.title.toLowerCase().includes(`season ${season}`) ||
                        r.title.toLowerCase().includes(`${season}nd season`) ||
                        r.title.toLowerCase().includes(`${season}rd season`) ||
                        r.title.toLowerCase().includes(`${season}th season`) ||
                        r.title.toLowerCase().includes(`part ${season}`) ||
                        (seasonRoman && r.title.includes(` ${seasonRoman}`)) ||
                        r.slug.includes(`-season-${season}`) ||
                        r.slug.includes(`-${season - 1}`) // e.g. -1 for season 2
                    );
                }
                
                if (bestMatch) {
                    cleanSlug = bestMatch.slug;
                    targetUrl = `/watch/${cleanSlug}/ep-${episode}`;
                    const searchFallback = await fetchPage(targetUrl);
                    html = searchFallback.html;
                    status = searchFallback.status;
                }
            }
        } catch (err) {
            logger.warn(`AnimeKai search fallback failed for ${slug}:`, err.message);
        }
    }
    
    if (!html || status === 404) return [];

    const sources = [];
    const serverRegex = /<span class="server[^"]*"[^>]*data-url="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
    let match;

    while ((match = serverRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.startsWith('http')) continue;

      const label = match[2].trim().replace(/<[^>]+>/g, '');
      
      // Determine sub/dub based on the parent tab/group in real DOM, 
      // but simple string check in URL is faster.
      const isDub = url.includes('/dub');
      const suffix = isDub ? ' (Dub)' : ' (Sub)';

      sources.push({
        url: url,
        type: 'iframe',
        label: `AnimeKai ${label}${suffix}`,
        trusted: true
      });
    }

    const episodesList = [];
    const epLinkRegex = new RegExp(`href="[^"]*\\/watch\\/${cleanSlug}\\/ep-(\\d+)"`, 'gi');
    let epMatch;
    const seenEps = new Set();
    
    while ((epMatch = epLinkRegex.exec(html)) !== null) {
      const epNum = parseInt(epMatch[1], 10);
      if (!seenEps.has(epNum)) {
        seenEps.add(epNum);
        episodesList.push({
          id: `ep_animekai_${cleanSlug}_${season}x${epNum}`,
          animeId: `animekai_${cleanSlug}`,
          animeSlug: cleanSlug,
          season: parseInt(season) || 1,
          episode: epNum,
          title: `Episode ${epNum}`,
          url: `/watch/${cleanSlug}/ep-${epNum}`,
          sources: (epNum === parseInt(episode)) ? sources : []
        });
      }
    }
    
    // If no episode links found but we have sources (e.g. movie), fallback to single
    if (episodesList.length === 0 && sources.length > 0) {
      episodesList.push({
        id: `ep_animekai_${cleanSlug}_${season}x${episode}`,
        animeId: `animekai_${cleanSlug}`,
        animeSlug: cleanSlug,
        season: parseInt(season) || 1,
        episode: parseInt(episode),
        title: `Episode ${episode}`,
        url: targetUrl,
        sources: sources
      });
    }

    return episodesList;
  } catch (err) {
    logger.warn(`AnimeKai getLiveEpisodes failed for ${slug}:`, err.message);
    return [];
  }
}

module.exports = {
  searchAnime,
  getAnimeDetails,
  getLiveEpisodes
};
