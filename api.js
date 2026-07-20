/**
 * MovieBox - API Service (ToonStream MongoDB Integration)
 */

window.API_CONFIG = {
  API_BASE: '/api/v1',
  CACHE_TIME: 300000,   // 5 minutes for browse data
  CACHE_VERSION: 'v4', // bump this to invalidate ALL old cached entries
};

const API = {

  async getMovies(type = 'movie', filter = 'trending', page = 1, query = '', genre = '') {
    // Never cache search queries — always fetch fresh from server
    const cacheKey = `${window.API_CONFIG.CACHE_VERSION}_toon_${type}_${filter}_${page}_${query}_${genre}`;
    if (!query) {
      const cached = this.getCachedData(cacheKey);
      if (cached) return cached;
    }

    let url = '';
    if (query) {
      url = `${window.API_CONFIG.API_BASE}/search?q=${encodeURIComponent(query)}`;
    } else {
      url = `${window.API_CONFIG.API_BASE}/anime?filter=${filter}&page=${page}&genre=${encodeURIComponent(genre)}&type=${type === 'anime' ? '' : type}`;
    }

    try {
      const resp = await fetch(url);
      let data = await resp.json();

      if (query) {
        // Search results are returned as direct list; format as { results: [...] }
        data = { results: Array.isArray(data) ? data : [] };
      } else {
        // Only cache non-search browse results
        this.cacheData(cacheKey, data);
      }

      return data;
    } catch (err) {
      return { _error: err.message, results: [] };
    }
  },

  async getTrailer(id, type = 'movie') {
    try {
      const resp = await fetch(`${window.API_CONFIG.API_BASE}/anime/details?id=${id}`);
      const data = await resp.json();
      // If the crawler extracted a trailer iframe source from ToonStream details page
      if (data && data.trailer) {
        return data.trailer;
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  async getGenres(type = 'movie') {
    try {
      const resp = await fetch(`${window.API_CONFIG.API_BASE}/genres`);
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  },

  async getExternalIds(id, type = 'tv') {
    return null;
  },

  cacheData(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) { }
  },

  getCachedData(key) {
    try {
      const c = localStorage.getItem(key);
      if (!c) return null;
      const o = JSON.parse(c);
      if ((Date.now() - o.ts) < window.API_CONFIG.CACHE_TIME) return o.data;
    } catch (e) { }
    return null;
  },

  async checkCatalog(title, id) {
    return { inCatalog: true };
  },

  async initCatalog() {
    return true;
  },
};

window.API = API;
