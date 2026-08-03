/* global API, Fuse, StreamPlayer, Hls */
/**
 * MovieBox - Main Application Logic
 * Integrates API fetching, UI rendering, searching, and interactions.
 * v2.0 - Uses server-side catalog, versioned API, StreamPlayer, and Fuse.js search.
 */

const App = {
  movies: [],
  currentFilter: 'trending',
  currentPage: 1,
  totalPages: 500,
  searchQuery: '',
  recentlyViewed: (() => {
    try { return JSON.parse(localStorage.getItem('recently_viewed')) || []; }
    catch (e) { return []; }
  })(),
  renderedIds: new Set(),
  episodeSourcesCache: {},
  animeDetailsCache: {},

  animePool: [],
  animePage: 1,
  animePagesLoaded: 1,

  cartoonPool: [],
  cartoonPage: 1,
  cartoonPagesLoaded: 1,

  moviePool: [],
  moviePage: 1,
  moviePagesLoaded: 1,

  freshDropPool: [],
  freshDropPage: 1,
  freshDropPagesLoaded: 1,

  upcomingPool: [],
  upcomingPage: 1,
  upcomingPagesLoaded: 1,

  animeSeriesPool: [],
  animeSeriesPage: 1,
  animeSeriesPagesLoaded: 1,

  animeMoviesPool: [],
  animeMoviesPage: 1,
  animeMoviesPagesLoaded: 1,

  cartoonSeriesPool: [],
  cartoonSeriesPage: 1,
  cartoonSeriesPagesLoaded: 1,

  cartoonMoviesPool: [],
  cartoonMoviesPage: 1,
  cartoonMoviesPagesLoaded: 1,

  renderedCount: 0,

  singleCategoryMode: 'fresh-drop', // 'fresh-drop', 'upcoming', 'anime-series', 'anime-movies', 'cartoon-series', 'cartoon-movies'
  singleCategoryPage: 1,
  animeSubFilter: 'anime',
  _catalogExhausted: false, // true when current filter has no more pages
  _fallbackFilters: ['popular', 'top_rated', 'trending', 'fresh-drop'], // cycle through when exhausted
  _fallbackFilterIndex: 0, // index into _fallbackFilters
  _infiniteObserver: null,  // IntersectionObserver for infinite scroll

  filterHidden(items) {
    if (!items || !Array.isArray(items)) return [];
    const cache = this.hiddenCache || new Set();
    return items.filter(item => !cache.has(String(item.id)));
  },

  // ── Initialize hiddenCache (prevents new Set() on every filterHidden call) ──
  _ensureHiddenCache() {
    if (!this.hiddenCache) this.hiddenCache = new Set();
  },

  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fas fa-info-circle"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      toast.style.transition = 'all 0.5s ease';
      setTimeout(() => toast.remove(), 500);
    }, 4000);
  },

  showNoTrailer(noTrailerEl, text = null) {
    if (!noTrailerEl) return;
    if (text) {
      const msgEl = noTrailerEl.querySelector('.no-trailer-text');
      if (msgEl) msgEl.textContent = text;
    }
    // Restore layout
    noTrailerEl.style.display = 'flex';
    noTrailerEl.style.position = '';
    noTrailerEl.style.visibility = '';
    noTrailerEl.style.opacity = '';
    noTrailerEl.style.pointerEvents = '';
    noTrailerEl.style.height = '';
    noTrailerEl.style.padding = '';
  },

  hideNoTrailer(noTrailerEl) {
    if (!noTrailerEl) return;
    // Hide visually but keep iframe alive to prevent third-party script crashes
    noTrailerEl.style.position = 'absolute';
    noTrailerEl.style.visibility = 'hidden';
    noTrailerEl.style.opacity = '0';
    noTrailerEl.style.pointerEvents = 'none';
    noTrailerEl.style.height = '0';
    noTrailerEl.style.padding = '0';
  },

  decodeHtmlEntities(str) {
    if (!str) return '';
    const tempEl = document.createElement('textarea');
    tempEl.innerHTML = str;
    return tempEl.value;
  },

  async syncDatabaseCache(force = false) {
    const now = Date.now();
    if (!force && this._lastDbSync && (now - this._lastDbSync) < 30_000) return;
    this._lastDbSync = now;

    try {
      const fetchJson = async (url) => {
        const cacheKey = `db_cache_${url.replace(/\//g, '_')}`;
        if (!force) {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            try {
              const { data, timestamp } = JSON.parse(cached);
              if (now - timestamp < 60_000) { // 1 minute local cache
                return data;
              }
            } catch (e) { }
          }
        }
        const r = await fetch(url, { credentials: 'include' });
        const data = r.ok ? await r.json() : [];
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ data, timestamp: now }));
        } catch (e) { }
        return data;
      };

      const [adminData, hiddenData, hindiData] = await Promise.all([
        fetchJson('/api/v1/admin-store'),
        fetchJson('/api/v1/hidden-items'),
        fetchJson('/api/v1/hindi-dubbed')
      ]);

      this.adminCache = {};
      if (Array.isArray(adminData)) {
        const settings = adminData.find(item => item.id === 'global_settings');
        if (settings) {
          if (settings.requires_ads_servers) {
            localStorage.setItem('moviebox_requires_ads_servers', JSON.stringify(settings.requires_ads_servers));
          }
          if (settings.default_play_server) {
            localStorage.setItem('moviebox_default_play_server', settings.default_play_server);
          } else {
            localStorage.removeItem('moviebox_default_play_server');
          }
        }
        adminData.forEach(item => {
          if (item.id !== 'global_settings') {
            this.adminCache[item.id] = item;
          }
        });
      }

      this.hiddenCache = new Set();
      if (Array.isArray(hiddenData)) {
        hiddenData.forEach(item => {
          this.hiddenCache.add(String(item.id));
        });
      }

      this.hindiCache = {};
      if (Array.isArray(hindiData)) {
        hindiData.forEach(item => {
          this.hindiCache[item.id] = item;
        });
      }
    } catch (e) {
      console.error("Failed to sync database cache:", e);
      this.adminCache = {};
      this.hiddenCache = new Set();
      this.hindiCache = {};
    }
  },

  // Elements
  grid: document.getElementById('movie-container'),
  modal: document.getElementById('movie-modal'),
  searchBar: document.getElementById('movie-search'),
  filterChips: document.querySelectorAll('.filter-chip'),
  ytPlayer: null,

  /**
   * Initialize the application
   */
  _loadLocalCacheSync() {
    try {
      const getLocal = (key) => {
        const cached = localStorage.getItem(key);
        if (cached) {
          try { return JSON.parse(cached).data; } catch (e) { }
        }
        return [];
      };

      const adminData = getLocal('db_cache__api_v1_admin-store');
      const hiddenData = getLocal('db_cache__api_v1_hidden-items');
      const hindiData = getLocal('db_cache__api_v1_hindi-dubbed');

      this.adminCache = {};
      if (Array.isArray(adminData)) {
        const settings = adminData.find(item => item.id === 'global_settings');
        if (settings) {
          if (settings.requires_ads_servers) {
            localStorage.setItem('moviebox_requires_ads_servers', JSON.stringify(settings.requires_ads_servers));
          }
          if (settings.default_play_server) {
            localStorage.setItem('moviebox_default_play_server', settings.default_play_server);
          }
        }
        adminData.forEach(item => {
          if (item.id !== 'global_settings') {
            this.adminCache[item.id] = item;
          }
        });
      }

      this.hiddenCache = new Set();
      if (Array.isArray(hiddenData)) {
        hiddenData.forEach(item => {
          this.hiddenCache.add(String(item.id));
        });
      }

      this.hindiCache = {};
      if (Array.isArray(hindiData)) {
        hindiData.forEach(item => {
          this.hindiCache[item.id] = item;
        });
      }
    } catch (e) { }
  },

  async init() {
    // Load existing cache from localStorage instantly to avoid any network delay
    this._loadLocalCacheSync();

    // Show skeletons instantly so the user sees a loading state immediately
    if (this.grid) {
      this.grid.innerHTML = '';
      this.showSkeletons();
    }

    // Sync database cache in background (non-blocking)
    this.syncDatabaseCache().catch(() => { });

    // Clear stale single-episode anime selector caches so they get rebuilt properly
    try {
      const staleSelectorKeys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('toon_eps_selector_')) {
          try {
            const val = JSON.parse(sessionStorage.getItem(key));
            if (Array.isArray(val) && val.length <= 1) staleSelectorKeys.push(key);
          } catch (e) { }
        }
      }
      staleSelectorKeys.forEach(k => sessionStorage.removeItem(k));
    } catch (e) { }
    // Clear stale toon_post caches that don't have season count
    try {
      const stalePostKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('toon_post_')) {
          try {
            const val = JSON.parse(localStorage.getItem(key));
            if (!val || typeof val.seasons === 'undefined') stalePostKeys.push(key);
          } catch (e) { }
        }
      }
      stalePostKeys.forEach(k => localStorage.removeItem(k));
    } catch (e) { }
    // Clear old mv5_ prefixed localStorage caches only (NOT recently_viewed)
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mv5_')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) { }

    this.setupEventListeners();
    this.setupRouting();
    if (window.API && typeof window.API.initCatalog === 'function') {
      await window.API.initCatalog();
    }

    await this.resetAndFetch(true);

    const activeType = this.singleCategoryMode;

    // Apply correct visibility for hero on initial load (recently-viewed always stays visible)
    const seoHeroInit = document.getElementById('seo-hero');
    if (activeType && activeType !== 'combined') {
      if (seoHeroInit) seoHeroInit.style.display = 'none';
    }
    
    document.querySelectorAll('.category-filter-btn').forEach(btn => {
      if (btn.dataset.filterType === activeType) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
      }
    });

    this.renderRecentlyViewed();
    this.setupNavScroll();
  },

  /**
   * Event Listeners setup
   */
  setupEventListeners() {
    window.addEventListener('beforeunload', () => {
      sessionStorage.setItem('s_scrollTop', window.scrollY);
    });

    // Search with debounce
    let debounceTimer;
    this.searchBar.addEventListener('input', (e) => {
      const clearBtn = document.getElementById('search-clear');
      if (e.target.value.trim() !== '') {
        if (clearBtn) clearBtn.style.display = 'block';
      } else {
        if (clearBtn) clearBtn.style.display = 'none';
      }

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.searchQuery = e.target.value.trim();
        this.handleSearch();
      }, 500);
    });

    // Search clear button
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.searchBar.value = '';
        clearBtn.style.display = 'none';
        this.searchQuery = '';
        this.handleSearch();
      });
    }

    // Category Filter Buttons (Fresh Drop, Anime Series, Anime Movies, Cartoon Series, Cartoon Movies)
    const categoryBtns = document.querySelectorAll('.category-filter-btn');
    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        categoryBtns.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');

        const filterType = btn.dataset.filterType;
        
        // Reset state — all pools and pages
        this.animePool = [];
        this.cartoonPool = [];
        this.moviePool = [];
        this.freshDropPool = [];
        this.upcomingPool = [];
        this.animeSeriesPool = [];
        this.animeMoviesPool = [];
        this.cartoonSeriesPool = [];
        this.cartoonMoviesPool = [];

        this.animePage = 1;
        this.cartoonPage = 1;
        this.moviePage = 1;
        this.freshDropPage = 1;
        this.upcomingPage = 1;
        this.animeSeriesPage = 1;
        this.animeMoviesPage = 1;
        this.cartoonSeriesPage = 1;
        this.cartoonMoviesPage = 1;

        this.animePagesLoaded = 1;
        this.cartoonPagesLoaded = 1;
        this.moviePagesLoaded = 1;
        this.freshDropPagesLoaded = 1;
        this.upcomingPagesLoaded = 1;
        this.animeSeriesPagesLoaded = 1;
        this.animeMoviesPagesLoaded = 1;
        this.cartoonSeriesPagesLoaded = 1;
        this.cartoonMoviesPagesLoaded = 1;

        sessionStorage.setItem('s_freshDropPagesLoaded', '1');
        sessionStorage.setItem('s_upcomingPagesLoaded', '1');
        sessionStorage.setItem('s_animeSeriesPagesLoaded', '1');
        sessionStorage.setItem('s_animeMoviesPagesLoaded', '1');
        sessionStorage.setItem('s_cartoonSeriesPagesLoaded', '1');
        sessionStorage.setItem('s_cartoonMoviesPagesLoaded', '1');
        this.singleCategoryMode = filterType;
        localStorage.setItem('cinestream_active_filter', filterType);

        this.grid.innerHTML = '';
        this.renderedIds.clear();
        this.showSkeletons();

        // Show/hide SEO hero based on page (recently-viewed always stays visible)
        const seoHero = document.getElementById('seo-hero');
        if (filterType === 'combined') {
          if (seoHero) seoHero.style.display = '';
          this.renderRecentlyViewed();
        } else {
          if (seoHero) seoHero.style.display = 'none';
        }

        this._isLoadingFeed = false;
        this.fetchAndRenderBatch();
      });
    });

    // Filter Chips (Trending, Popular, etc.)
    this.filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        this.filterChips.forEach(c => {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        this.currentFilter = chip.dataset.filter;

        if (this.singleCategoryMode && this.singleCategoryMode !== 'combined') {
          // Reset the pool & page pointers for the active category
          const category = this.singleCategoryMode;
          const key = category.replace(/-/g, '');
          if (this[key + 'Pool'] !== undefined) this[key + 'Pool'] = [];
          if (this[key + 'Page'] !== undefined) this[key + 'Page'] = 1;
          
          this.grid.innerHTML = '';
          this.renderedIds.clear();
          this.showSkeletons();
          this.fetchAndRenderBatch();
        } else {
          this.resetAndFetch();
        }
      });
    });

    // Modal close events
    document.getElementById('close-modal').addEventListener('click', () => this.closeModal());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.closeModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.classList.contains('active')) this.closeModal();
    });

    // Sound toggle in modal
    document.getElementById('sound-toggle').addEventListener('click', () => this.toggleSound());

    // ── Infinite Scroll setup ─────────────────────────────────────────────────
    this._setupInfiniteScroll();

    // Back to feed button click listener
    const backToFeedBtn = document.getElementById('back-to-feed-btn');
    if (backToFeedBtn) {
      backToFeedBtn.onclick = () => {
        this.resetAndFetch();
      };
    }

    // Anime filter selector
    const animeSelect = document.getElementById('anime-filter-select');
    if (animeSelect) {
      animeSelect.addEventListener('change', (e) => {
        this.animeSubFilter = e.target.value;
        // Reset pool & pagination for anime, and re-fetch
        this.animePool = [];
        this.animePage = 1;
        sessionStorage.setItem('s_animePage', '1');
        this.grid.innerHTML = '';
        this.renderedIds.clear();
        this.showSkeletons();
        this.fetchAndRenderBatch();

        // Highlight logic
        if (e.target.value !== 'all') {
          animeSelect.classList.add('active');
          animeSelect.style.borderColor = 'var(--primary)';
          animeSelect.style.background = 'rgba(255, 71, 87, 0.2)';
        } else {
          animeSelect.classList.remove('active');
          animeSelect.style.borderColor = 'var(--glass-border)';
          animeSelect.style.background = 'var(--glass)';
        }
      });
    }
  },

  /**
   * Routing setup (URL based state)
   */
  setupRouting() {
    // 1. Legacy Hash Redirect support for backwards compatibility
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash;
      if (hash.startsWith('#media/') || hash.startsWith('#watch/')) {
        const parts = hash.split('/');
        const mediaType = parts[1];
        const movieId = parts[2];
        const isWatching = hash.startsWith('#watch/');
        window.location.hash = ''; // Clear hash
        this.openModal(movieId, mediaType, true, isWatching); // pushState to clean URL
      } else if (hash === '') {
        const path = window.location.pathname;
        if (!path.startsWith('/media/') && !path.startsWith('/watch/')) {
          this.closeModal(false);
        }
      }
    });

    // 2. HTML5 History Navigation (PopState)
    window.addEventListener('popstate', () => {
      const path = window.location.pathname;
      if (path.startsWith('/media/') || path.startsWith('/watch/')) {
        const parts = path.split('/');
        const mediaType = parts[2];
        const movieId = parts[3];
        const isWatching = path.startsWith('/watch/');
        this.openModal(movieId, mediaType, false, isWatching);
      } else {
        this.closeModal(false);
      }
    });

    // 3. Initial load router
    const currentHash = window.location.hash;
    const currentPath = window.location.pathname;

    if (currentHash.startsWith('#media/') || currentHash.startsWith('#watch/')) {
      const parts = currentHash.split('/');
      const mediaType = parts[1];
      const movieId = parts[2];
      const isWatching = currentHash.startsWith('#watch/');
      window.location.hash = '';
      this.openModal(movieId, mediaType, true, isWatching);
    } else if (currentPath.startsWith('/media/') || currentPath.startsWith('/watch/')) {
      const parts = currentPath.split('/');
      const mediaType = parts[2];
      const movieId = parts[3];
      const isWatching = currentPath.startsWith('/watch/');
      this.openModal(movieId, mediaType, false, isWatching);
    }
  },

  /**
   * Reset feed variables and fetch first batch
   */
  async resetAndFetch(isInitial = false) {
    if (isInitial) {
      this.singleCategoryMode = localStorage.getItem('cinestream_active_filter') || 'combined';
    } else {
      this.singleCategoryMode = 'combined';
      localStorage.setItem('cinestream_active_filter', 'combined');
    }
    this.singleCategoryPage = 1;
    this.currentPage = 1;
    this._fallbackFilterIndex = 0;
    this._catalogExhausted = false;
    if (isInitial) {
      this.freshDropPagesLoaded = parseInt(sessionStorage.getItem('s_freshDropPagesLoaded') || '1', 10);
      this.upcomingPagesLoaded = parseInt(sessionStorage.getItem('s_upcomingPagesLoaded') || '1', 10);
      this.animeSeriesPagesLoaded = parseInt(sessionStorage.getItem('s_animeSeriesPagesLoaded') || '1', 10);
      this.animeMoviesPagesLoaded = parseInt(sessionStorage.getItem('s_animeMoviesPagesLoaded') || '1', 10);
      this.cartoonSeriesPagesLoaded = parseInt(sessionStorage.getItem('s_cartoonSeriesPagesLoaded') || '1', 10);
      this.cartoonMoviesPagesLoaded = parseInt(sessionStorage.getItem('s_cartoonMoviesPagesLoaded') || '1', 10);

      this.freshDropPage = this.freshDropPagesLoaded + 1;
      this.upcomingPage = this.upcomingPagesLoaded + 1;
      this.animeSeriesPage = this.animeSeriesPagesLoaded + 1;
      this.animeMoviesPage = this.animeMoviesPagesLoaded + 1;
      this.cartoonSeriesPage = this.cartoonSeriesPagesLoaded + 1;
      this.cartoonMoviesPage = this.cartoonMoviesPagesLoaded + 1;
    } else {
      this.freshDropPagesLoaded = 1;
      this.upcomingPagesLoaded = 1;
      this.animeSeriesPagesLoaded = 1;
      this.animeMoviesPagesLoaded = 1;
      this.cartoonSeriesPagesLoaded = 1;
      this.cartoonMoviesPagesLoaded = 1;

      this.freshDropPage = 2;
      this.upcomingPage = 2;
      this.animeSeriesPage = 2;
      this.animeMoviesPage = 2;
      this.cartoonSeriesPage = 2;
      this.cartoonMoviesPage = 2;

      sessionStorage.setItem('s_freshDropPagesLoaded', '1');
      sessionStorage.setItem('s_upcomingPagesLoaded', '1');
      sessionStorage.setItem('s_animeSeriesPagesLoaded', '1');
      sessionStorage.setItem('s_animeMoviesPagesLoaded', '1');
      sessionStorage.setItem('s_cartoonSeriesPagesLoaded', '1');
      sessionStorage.setItem('s_cartoonMoviesPagesLoaded', '1');
    }
    this.freshDropPool = [];
    this.upcomingPool = [];
    this.animeSeriesPool = [];
    this.animeMoviesPool = [];
    this.cartoonSeriesPool = [];
    this.cartoonMoviesPool = [];
    this.renderedCount = 0;
    this.grid.innerHTML = '';
    this.renderedIds.clear();
    this.showSkeletons();

    // Hide back to feed button & heading
    const backToFeedBtn = document.getElementById('back-to-feed-btn');
    if (backToFeedBtn) backToFeedBtn.style.display = 'none';
    const heading = document.getElementById('category-view-heading');
    if (heading) heading.style.display = 'none';

    // Restore SEO hero and recently-viewed-section on Home (combined) mode
    const seoHero = document.getElementById('seo-hero');
    if (seoHero) seoHero.style.display = '';
    this.renderRecentlyViewed(); // will show the section if history exists

    this.animeSubFilter = 'anime';
    const animeSelect = document.getElementById('anime-filter-select');
    if (animeSelect) {
      animeSelect.value = 'anime';
      animeSelect.style.display = 'none';
      animeSelect.classList.remove('active');
      animeSelect.style.borderColor = 'var(--glass-border)';
      animeSelect.style.background = 'var(--glass)';
    }

    // Hide search results and show main feed
    document.getElementById('search-results-section').style.display = 'none';
    document.getElementById('main-feed-section').style.display = 'block';

    const loadMoreContainer = document.getElementById('load-more-container');
    if (loadMoreContainer) loadMoreContainer.style.display = 'none';
    const paginationContainer = document.getElementById('pagination-container');
    if (paginationContainer) paginationContainer.style.display = 'none';

    await this.fetchAndRenderBatch();
  },

  /**
   * Switch into a single category view mode (resets feed to render 30 cards per page)
   */
  async switchToCategory(category) {
    document.querySelectorAll('.category-filter-btn').forEach(btn => {
      if (btn.dataset.filterType === category) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
      }
    });

    // Hide SEO hero only on single category pages (recently-viewed stays visible)
    const seoHero = document.getElementById('seo-hero');
    if (seoHero) seoHero.style.display = 'none';

    this.singleCategoryMode = category;
    this.singleCategoryPage = 1;
    this.moviePool = [];
    this.tvPool = [];
    this.animePool = [];
    this.moviePage = 1;
    this.tvPage = 1;
    this.animePage = 1;
    this.grid.innerHTML = '';
    this.renderedIds.clear();
    this.showSkeletons();

    // Scroll to the start of the movie-container grid (with offset for fixed header)
    const movieContainer = document.getElementById('movie-container');
    if (movieContainer) {
      const yOffset = -90;
      const y = movieContainer.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }

    // Show back to feed button & heading
    const backToFeedBtn = document.getElementById('back-to-feed-btn');
    if (backToFeedBtn) backToFeedBtn.style.display = 'block';

    const heading = document.getElementById('category-view-heading');
    if (heading) {
      const labels = {
        'fresh-drop':     'Fresh Drop',
        'upcoming':       'Upcoming',
        'anime':          'Anime',
        'cartoon':        'Animation & Cartoon',
        'movie':          'Movies',
        'anime-series':   'Anime Series',
        'anime-movies':   'Anime Movies',
        'cartoon-series': 'Cartoon Series',
        'cartoon-movies': 'Cartoon Movies'
      };
      const textElem = heading.querySelector('.heading-text') || heading;
      textElem.textContent = labels[category] || 'All Content';
      heading.style.display = 'flex';

      const animeSelect = document.getElementById('anime-filter-select');
      if (animeSelect) {
        if (category === 'anime') {
          animeSelect.style.display = 'block';
          animeSelect.value = this.animeSubFilter;
        } else {
          animeSelect.style.display = 'none';
        }
      }
    }

    const paginationContainer = document.getElementById('pagination-container');
    if (paginationContainer) paginationContainer.style.display = 'none';

    this._isLoadingFeed = false;
    await this.fetchAndRenderBatch();
  },

  /**
   * Setup IntersectionObserver sentinel for infinite scroll.
   * An invisible div is placed after the grid; when it enters the viewport the next batch loads.
   */
  _setupInfiniteScroll() {
    // Disconnect old observer if exists
    if (this._infiniteObserver) {
      this._infiniteObserver.disconnect();
      this._infiniteObserver = null;
    }
    // Remove old sentinel
    const oldSentinel = document.getElementById('infinite-sentinel');
    if (oldSentinel) oldSentinel.remove();

    // Create sentinel div below the grid
    const sentinel = document.createElement('div');
    sentinel.id = 'infinite-sentinel';
    sentinel.style.cssText = 'width:100%;height:1px;visibility:hidden;';
    if (this.grid && this.grid.parentNode) {
      this.grid.parentNode.insertBefore(sentinel, this.grid.nextSibling);
    }

    this._infiniteObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !this._isLoadingFeed) {
          this.fetchAndRenderBatch();
        }
      });
    }, { rootMargin: '300px' }); // Start loading 300px before sentinel is visible

    this._infiniteObserver.observe(sentinel);
  },

  /**
   * When the current category pool is exhausted, switch to the next fallback filter
   * so the infinite scroll continues seamlessly.
   */
  _tryFallbackFilter() {
    const fallbacks = this._fallbackFilters;
    if (this._fallbackFilterIndex >= fallbacks.length) {
      // All fallbacks exhausted — stop
      if (this._infiniteObserver) {
        this._infiniteObserver.disconnect();
        this._infiniteObserver = null;
      }
      const sentinel = document.getElementById('infinite-sentinel');
      if (sentinel) sentinel.remove();
      return;
    }
    const nextFilter = fallbacks[this._fallbackFilterIndex++];
    // Switch singleCategoryMode to the fallback filter and reset its pagination
    this.singleCategoryMode = nextFilter;
    this.animeSubFilter = 'anime';
    // Reset the pools and page for the fallback
    const key = nextFilter.replace(/-/g, '');
    if (this[key + 'Pool'] !== undefined) this[key + 'Pool'] = [];
    if (this[key + 'Page'] !== undefined) this[key + 'Page'] = 1;
    // Fetch the next batch silently (cards get appended to existing grid)
    this.fetchAndRenderBatch();
  },

  /**
   * Fetch and render feed cards. Supports Homepage Combined Mode and Single Category Mode.
   */
  async fetchAndRenderBatch() {
    if (this._isLoadingFeed) return;
    this._isLoadingFeed = true;

    const initialMode = this.singleCategoryMode;
    const initialFilter = this.currentFilter;

    const isMobile = window.innerWidth <= 768;
    const blockSize = isMobile ? 7 : 10;
    const fMap = { 'trending': 'Trending', 'popular': 'Popular', 'top_rated': 'Top Rated', 'upcoming': 'Upcoming' };
    const filterTxt = fMap[this.currentFilter] || 'Trending';

    if (this.singleCategoryMode && this.singleCategoryMode !== 'combined') {
      const type = this.singleCategoryMode;
      const targetSize = type === 'upcoming' ? 100 : 30;

      const skeletons = [];
      for (let i = 0; i < 12; i++) {
        const card = document.createElement('div');
        card.className = 'movie-card skeleton';
        this.grid.appendChild(card);
        skeletons.push(card);
      }

      try {
        const pool = type === 'fresh-drop' ? this.freshDropPool
                   : type === 'upcoming' ? this.upcomingPool
                   : type === 'anime' ? this.animePool
                   : type === 'cartoon' ? this.cartoonPool
                   : type === 'movie' ? this.moviePool
                   : type === 'anime-series' ? this.animeSeriesPool
                   : type === 'anime-movies' ? this.animeMoviesPool
                   : type === 'cartoon-series' ? this.cartoonSeriesPool
                   : type === 'cartoon-movies' ? this.cartoonMoviesPool
                   : this.animePool;

        const isFirstLoad = this.grid.querySelectorAll('.movie-card:not(.skeleton)').length === 0;

        let pagesToFetch = 1;
        let startPage = type === 'fresh-drop' ? this.freshDropPage
                      : type === 'upcoming' ? this.upcomingPage
                      : type === 'anime' ? this.animePage
                      : type === 'cartoon' ? this.cartoonPage
                      : type === 'movie' ? this.moviePage
                      : type === 'anime-series' ? this.animeSeriesPage
                      : type === 'anime-movies' ? this.animeMoviesPage
                      : type === 'cartoon-series' ? this.cartoonSeriesPage
                      : type === 'cartoon-movies' ? this.cartoonMoviesPage
                      : this.animePage;

        let currentTargetSize = targetSize;
        if (isFirstLoad) {
          startPage = 1;
          pagesToFetch = type === 'fresh-drop' ? this.freshDropPagesLoaded
                       : type === 'upcoming' ? this.upcomingPagesLoaded
                       : type === 'anime' ? this.animePagesLoaded
                       : type === 'cartoon' ? this.cartoonPagesLoaded
                       : type === 'movie' ? this.moviePagesLoaded
                       : type === 'anime-series' ? this.animeSeriesPagesLoaded
                       : type === 'anime-movies' ? this.animeMoviesPagesLoaded
                       : type === 'cartoon-series' ? this.cartoonSeriesPagesLoaded
                       : type === 'cartoon-movies' ? this.cartoonMoviesPagesLoaded
                       : this.animePagesLoaded;
          currentTargetSize = targetSize * pagesToFetch;
        } else {
          pagesToFetch = 1;
          if (type === 'fresh-drop') {
            this.freshDropPagesLoaded++;
            sessionStorage.setItem('s_freshDropPagesLoaded', this.freshDropPagesLoaded);
          } else if (type === 'upcoming') {
            this.upcomingPagesLoaded++;
            sessionStorage.setItem('s_upcomingPagesLoaded', this.upcomingPagesLoaded);
          } else if (type === 'anime') {
            this.animePagesLoaded++;
            sessionStorage.setItem('s_animePagesLoaded', this.animePagesLoaded);
          } else if (type === 'cartoon') {
            this.cartoonPagesLoaded++;
            sessionStorage.setItem('s_cartoonPagesLoaded', this.cartoonPagesLoaded);
          } else if (type === 'movie') {
            this.moviePagesLoaded++;
            sessionStorage.setItem('s_moviePagesLoaded', this.moviePagesLoaded);
          } else if (type === 'anime-series') {
            this.animeSeriesPagesLoaded++;
            sessionStorage.setItem('s_animeSeriesPagesLoaded', this.animeSeriesPagesLoaded);
          } else if (type === 'anime-movies') {
            this.animeMoviesPagesLoaded++;
            sessionStorage.setItem('s_animeMoviesPagesLoaded', this.animeMoviesPagesLoaded);
          } else if (type === 'cartoon-series') {
            this.cartoonSeriesPagesLoaded++;
            sessionStorage.setItem('s_cartoonSeriesPagesLoaded', this.cartoonSeriesPagesLoaded);
          } else if (type === 'cartoon-movies') {
            this.cartoonMoviesPagesLoaded++;
            sessionStorage.setItem('s_cartoonMoviesPagesLoaded', this.cartoonMoviesPagesLoaded);
          }
          const loadedVal = type === 'fresh-drop' ? this.freshDropPagesLoaded
                          : type === 'upcoming' ? this.upcomingPagesLoaded
                          : type === 'anime' ? this.animePagesLoaded
                          : type === 'cartoon' ? this.cartoonPagesLoaded
                          : type === 'movie' ? this.moviePagesLoaded
                          : type === 'anime-series' ? this.animeSeriesPagesLoaded
                          : type === 'anime-movies' ? this.animeMoviesPagesLoaded
                          : type === 'cartoon-series' ? this.cartoonSeriesPagesLoaded
                          : type === 'cartoon-movies' ? this.cartoonMoviesPagesLoaded
                          : this.animePagesLoaded;
          currentTargetSize = targetSize * loadedVal;
        }

        let currentPagePointer = startPage;
        if (isFirstLoad) {
          const loadedVal = type === 'fresh-drop' ? this.freshDropPagesLoaded
                          : type === 'upcoming' ? this.upcomingPagesLoaded
                          : type === 'anime' ? this.animePagesLoaded
                          : type === 'cartoon' ? this.cartoonPagesLoaded
                          : type === 'movie' ? this.moviePagesLoaded
                          : type === 'anime-series' ? this.animeSeriesPagesLoaded
                          : type === 'anime-movies' ? this.animeMoviesPagesLoaded
                          : type === 'cartoon-series' ? this.cartoonSeriesPagesLoaded
                          : type === 'cartoon-movies' ? this.cartoonMoviesPagesLoaded
                          : this.animePagesLoaded;
          const fetchPromises = [];
          for (let p = 1; p <= loadedVal; p++) {
            fetchPromises.push(API.getMovies(type, this.currentFilter, p, '', ''));
          }
          const allData = await Promise.all(fetchPromises);
          for (const data of allData) {
            if (data && data.results && data.results.length > 0) {
              let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));
              const existingIds = new Set(pool.map(pItem => String(pItem.id)));
              this.renderedIds.forEach(id => existingIds.add(id));
              results = results.filter(item => {
                const idStr = String(item.id);
                if (existingIds.has(idStr)) return false;
                existingIds.add(idStr);
                return true;
              });
              pool.push(...results);
            }
          }
          currentPagePointer = loadedVal + 1;
        } else {
          let attempts = 0;
          while (pool.length < currentTargetSize && attempts < 15) {
            attempts++;
            const data = await API.getMovies(type, this.currentFilter, currentPagePointer, '', '');
            if (data && data.results && data.results.length > 0) {
              let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));
              const existingIds = new Set(pool.map(pItem => String(pItem.id)));
              this.renderedIds.forEach(id => existingIds.add(id));
              results = results.filter(item => {
                const idStr = String(item.id);
                if (existingIds.has(idStr)) return false;
                existingIds.add(idStr);
                return true;
              });
              pool.push(...results);
              currentPagePointer++;
            } else {
              break;
            }
          }
        }

        // Race condition check: abort if mode/filter has changed during fetch
        if (this.singleCategoryMode !== initialMode || this.currentFilter !== initialFilter) {
          this._isLoadingFeed = false;
          return;
        }

        if (type === 'fresh-drop') { this.freshDropPage = currentPagePointer; }
        else if (type === 'upcoming') { this.upcomingPage = currentPagePointer; }
        else if (type === 'anime') { this.animePage = currentPagePointer; }
        else if (type === 'cartoon') { this.cartoonPage = currentPagePointer; }
        else if (type === 'movie') { this.moviePage = currentPagePointer; }
        else if (type === 'anime-series') { this.animeSeriesPage = currentPagePointer; }
        else if (type === 'anime-movies') { this.animeMoviesPage = currentPagePointer; }
        else if (type === 'cartoon-series') { this.cartoonSeriesPage = currentPagePointer; }
        else if (type === 'cartoon-movies') { this.cartoonMoviesPage = currentPagePointer; }
        else { this.animePage = currentPagePointer; }

        // Remove ALL skeleton cards (original 12 from showSkeletons + our 12 just appended)
        this.grid.querySelectorAll('.movie-card.skeleton').forEach(s => s.remove());

        const itemsToRender = isFirstLoad ? pool.splice(0, currentTargetSize) : pool.splice(0, targetSize);
        if (itemsToRender.length === 0) {
          if (this.grid.children.length === 0) {
            this.grid.innerHTML = `
              <div style="grid-column: 1 / -1; text-align: center; padding: 5rem 2rem; color: var(--text-muted); font-size: 1.5rem; font-weight: 600; background: var(--glass); border: 1px solid var(--glass-border); border-radius: 12px;">
                Not Found
              </div>
            `;
          }
          const loadMoreContainer = document.getElementById('load-more-container');
          if (loadMoreContainer) loadMoreContainer.style.display = 'none';
          if (type === 'fresh-drop' || type === 'upcoming') {
            this._tryFallbackFilter();
          }
          return;
        }

        const cardsHtml = itemsToRender.map((m, idx) => {
          this.renderedIds.add(String(m.id));
          // Support both ToonStream DB fields and legacy TMDB-shaped admin entries
          const title = m.title || m.name || 'Unknown';
          const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const year = m.release_year
            ? String(m.release_year)
            : (m.release_date || m.first_air_date || '????').split('-')[0];
          const rawRating = m.rating || m.vote_average;
          const rating = (rawRating && parseFloat(rawRating) > 0)
            ? parseFloat(rawRating).toFixed(1)
            : '7.5';
          // Poster: prefer ToonStream 'poster' field; fall back to TMDB-style poster_path for admin entries
          const poster = m.poster
            ? m.poster
            : (m.poster_path
              ? (m.poster_path.startsWith('http') ? m.poster_path : 'https://image.tmdb.org/t/p/w500' + m.poster_path)
              : 'https://placehold.co/500x750?text=No+Poster');
          const posterSm = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w185/') : poster;
          const posterMd = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w342/') : poster;
          const typeVal = m.type || (m.title ? 'movie' : 'tv');
          const contentType = this.getContentType(m, typeVal);

          const imgAttrs = `decoding="async" loading="eager"`;

          const badgeText = m.schedule_time
            ? (m.schedule_note ? `${m.schedule_time} • ${m.schedule_note}` : m.schedule_time)
            : '';
          const scheduleBadge = badgeText
            ? `<span class="schedule-badge" aria-hidden="true">${badgeText}</span>`
            : '';

          const srcsetAttr = poster.startsWith('data:')
            ? ''
            : `srcset="${posterSm} 185w, ${posterMd} 342w, ${poster} 500w"`;

          const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><rect width="500" height="750" fill="#181524"/><text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="#e0e0e0" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-weight="700" font-size="28">No Poster</text><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#e50914" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-weight="800" font-size="34">CineStream</text></svg>`;
          const fallbackPoster = `data:image/svg+xml;base64,${btoa(fallbackSvg)}`;

          const dayBadge = m.schedule_day
            ? `<span class="day-badge" aria-hidden="true">${m.schedule_day.substring(0, 3)}</span>`
            : '';

          return `
            <div class="movie-card fade-in" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${typeVal}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle} (${year}) - ${contentType}">
              <span class="type-badge" aria-hidden="true">${contentType}</span>
              ${dayBadge}
              ${scheduleBadge}
              <img
                src="${poster}"
                ${srcsetAttr}
                sizes="(max-width: 480px) 150px, (max-width: 768px) 185px, 240px"
                alt="${safeTitle} poster"
                ${imgAttrs}
                width="500"
                height="750"
                onload="this.parentElement.classList.add('loaded')"
                onerror="this.removeAttribute('srcset'); this.src='${fallbackPoster}'; this.parentElement.classList.add('loaded');"
              >
              <div class="movie-card-info">
                <h4 class="movie-title">${safeTitle}</h4>
                <div class="movie-meta">
                  <span><i class="fas fa-star rating-star" aria-hidden="true"></i> ${rating}</span>
                  <span>${year}</span>
                </div>
              </div>
            </div>
          `;
        }).join('');


        const batchContainer = document.createElement('div');
        batchContainer.style.display = 'contents';
        batchContainer.innerHTML = cardsHtml;
        this.grid.appendChild(batchContainer);

        // Pad incomplete last row — use double rAF to ensure browser has fully
        // computed grid layout before we measure card positions
        requestAnimationFrame(() => requestAnimationFrame(() => {
          // Clear stale placeholders
          this.grid.querySelectorAll('.movie-card-placeholder').forEach(p => p.remove());

          const cards = Array.from(this.grid.querySelectorAll('.movie-card:not(.skeleton)'));
          if (cards.length === 0) return;

          // Group cards into rows by their top-edge position (±2px tolerance for sub-pixel)
          const rowMap = new Map();
          cards.forEach(card => {
            const top = Math.round(card.getBoundingClientRect().top);
            rowMap.set(top, (rowMap.get(top) || 0) + 1);
          });

          const rowCounts = Array.from(rowMap.values());
          const cols = Math.max(...rowCounts);               // widest row = column count
          const lastRowCount = rowCounts[rowCounts.length - 1];
          const needed = cols - lastRowCount;

          for (let i = 0; i < needed; i++) {
            const ph = document.createElement('div');
            ph.className = 'movie-card-placeholder';
            ph.setAttribute('aria-hidden', 'true');
            this.grid.appendChild(ph);
          }
        }));

        // Restore scroll position if saved on page reload
        const savedScroll = parseInt(sessionStorage.getItem('s_scrollTop') || '0', 10);
        if (savedScroll > 0) {
          setTimeout(() => {
            window.scrollTo({ top: savedScroll, behavior: 'instant' });
            sessionStorage.removeItem('s_scrollTop');
          }, 100);
        }

        // Auto-scan visible category items for 404 links in background
        this.scanFeedForBrokenVideos(itemsToRender);

        const isInfiniteType = type === 'fresh-drop' || type === 'upcoming';
        let loadMoreContainer = document.getElementById('load-more-container');

        if (isInfiniteType) {
          // Infinite Scroll mode
          if (loadMoreContainer) loadMoreContainer.style.display = 'none';
          this._setupInfiniteScroll();
        } else {
          // Manual button click mode
          if (this._infiniteObserver) {
            this._infiniteObserver.disconnect();
            this._infiniteObserver = null;
          }
          const sentinel = document.getElementById('infinite-sentinel');
          if (sentinel) sentinel.remove();

          if (!loadMoreContainer) {
            loadMoreContainer = document.createElement('div');
            loadMoreContainer.id = 'load-more-container';
            loadMoreContainer.style.textAlign = 'center';
            loadMoreContainer.style.margin = '2rem 0';
            loadMoreContainer.innerHTML = '<button id="load-more-btn" class="btn-primary">View More</button>';
            this.grid.parentNode.insertBefore(loadMoreContainer, this.grid.nextSibling);
          }

          loadMoreContainer.style.display = 'block';
          const loadMoreBtn = document.getElementById('load-more-btn');
          if (loadMoreBtn) {
            loadMoreBtn.onclick = () => {
              this.fetchAndRenderBatch();
            };
          }
        }

        const paginationContainer = document.getElementById('pagination-container');
        if (paginationContainer) paginationContainer.style.display = 'none';

      } catch (e) {
        console.error(e);
        // Remove ALL skeletons on error too
        this.grid.querySelectorAll('.movie-card.skeleton').forEach(s => s.remove());
      } finally {
        this._isLoadingFeed = false;
      }
      return;
    }

    // 2. Homepage Feed Combined Mode (Netflix-style rows for each category)
    this.grid.innerHTML = `
      <div style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 2rem;">
        ${Array(6).fill(`
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">
              <div class="skeleton" style="width: 150px; height: 1.5rem; border-radius: 4px; background: rgba(255,255,255,0.05);"></div>
              <div class="skeleton" style="width: 80px; height: 1.5rem; border-radius: 4px; background: rgba(255,255,255,0.05);"></div>
            </div>
            <div style="display: flex; gap: 1rem; overflow: hidden; padding-bottom: 0.8rem;">
              ${Array(8).fill('<div class="movie-card skeleton" style="flex: 0 0 150px; width: 150px; height: 225px;"></div>').join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    try {
      const categories = [
        { id: 'fresh-drop',    label: 'Fresh Drop',           fallbackType: 'tv' },
        { id: 'upcoming',      label: 'Upcoming',             fallbackType: 'tv' },
        { id: 'anime',         label: 'Anime',                fallbackType: 'tv' },
        { id: 'cartoon',       label: 'Animation & Cartoon',  fallbackType: 'tv' },
        { id: 'movie',         label: 'Movies',               fallbackType: 'movie' },
        { id: 'cartoon-movies', label: 'Cartoon Movies',      fallbackType: 'movie' }
      ];

      const fetchResults = {};
      const fetchPromises = categories.map(async (cat) => {
        let pool = [];
        let page = 1;
        let attempts = 0;
        // Fetch until we have 20 items or reach 3 attempts/pages
        while (pool.length < 20 && attempts < 3) {
          attempts++;
          const data = await API.getMovies(cat.id, this.currentFilter, page, '', '');
          if (data && data.results && data.results.length > 0) {
            let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));
            // NOTE: Do NOT filter upcoming by release_date — upcoming items use schedule_day/schedule_time
            const seen = new Set(pool.map(p => String(p.id)));
            results.forEach(r => {
              if (!seen.has(String(r.id))) {
                pool.push(r);
                seen.add(String(r.id));
              }
            });
            page++;
          } else {
            break;
          }
        }
        fetchResults[cat.id] = pool.slice(0, 20);
      });

      await Promise.all(fetchPromises);

      // Race condition check: abort if mode/filter has changed during fetch
      if (this.singleCategoryMode !== initialMode || this.currentFilter !== initialFilter) {
        this._isLoadingFeed = false;
        return;
      }

      const renderRow = (cat) => {
        const items = fetchResults[cat.id] || [];
        const headingHtml = `
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem; margin-bottom: 0.5rem;">
            <h3 class="section-title" style="margin: 0; font-size: clamp(1rem, 2vw, 1.25rem); font-weight: 700;">
              ${cat.label}
            </h3>
            <button class="btn-secondary" style="font-size: 0.72rem; padding: 4px 10px; margin: 0; border-radius: 6px;" onclick="App.switchToCategory('${cat.id}')">
              View All
            </button>
          </div>
        `;

        if (items.length === 0) {
          return `
            <div style="display: flex; flex-direction: column; width: 100%;">
              ${headingHtml}
              <div style="text-align: center; padding: 2rem; color: var(--text-muted); font-size: 1rem; background: var(--glass); border: 1px solid var(--glass-border); border-radius: 8px;">
                No content available
              </div>
            </div>
          `;
        }

        const cardsHtml = items.map((m) => {
          this.renderedIds.add(String(m.id));
          const title = m.title || m.name || 'Unknown';
          const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const year = (m.release_date || m.first_air_date || '????').split('-')[0];
          const rating = (m.vote_average && m.vote_average > 0) ? m.vote_average.toFixed(1) : '7.5';
          const isManual = m.manual === true;
          const poster = m.poster
            ? m.poster
            : (m.poster_path
              ? (m.poster_path.startsWith('http') ? m.poster_path : 'https://image.tmdb.org/t/p/w500' + m.poster_path)
              : 'https://placehold.co/500x750?text=No+Poster');
          const posterSm = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w185/') : poster;
          const posterMd = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w342/') : poster;
          const type = isManual ? (m.type || cat.fallbackType) : (m.title ? 'movie' : 'tv');
          const contentType = this.getContentType(m, type);

          const badgeText = m.schedule_time
            ? (m.schedule_note ? `${m.schedule_time} • ${m.schedule_note}` : m.schedule_time)
            : '';
          const scheduleBadge = badgeText
            ? `<span class="schedule-badge" aria-hidden="true">${badgeText}</span>`
            : '';
          const dayBadge = m.schedule_day
            ? `<span class="day-badge" aria-hidden="true">${m.schedule_day.substring(0, 3)}</span>`
            : '';

          return `
            <div class="movie-card fade-in" style="flex: 0 0 150px; width: 150px; scroll-snap-align: start;" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${type}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle}">
              <span class="type-badge" aria-hidden="true">${contentType}</span>
              ${dayBadge}
              ${scheduleBadge}
              <img
                src="${poster}"
                srcset="${posterSm} 185w, ${posterMd} 342w, ${poster} 500w"
                sizes="(max-width:480px) 110px, (max-width:768px) 150px, 200px"
                alt="${safeTitle} poster"
                decoding="async"
                loading="lazy"
                width="150"
                height="225"
                onload="this.parentElement.classList.add('loaded')"
                onerror="this.src='https://placehold.co/500x750?text=No+Poster'; this.parentElement.classList.add('loaded');"
              >
              <div class="movie-card-info" style="padding: 0.5rem;">
                <h4 class="movie-title" style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%;">${safeTitle}</h4>
                <div class="movie-meta" style="font-size: 0.7rem;">
                  <span><i class="fas fa-star rating-star" aria-hidden="true"></i> ${rating}</span>
                  <span>${year}</span>
                </div>
              </div>
            </div>
          `;
        }).join('');

        return `
          <div style="display: flex; flex-direction: column; width: 100%;">
            ${headingHtml}
            <div class="category-row-scroll" style="display: flex; overflow-x: auto; gap: 1rem; padding-bottom: 0.8rem; scroll-snap-type: x mandatory;">
              ${cardsHtml}
            </div>
          </div>
        `;
      };

      this.grid.innerHTML = '';
      this.renderedIds.clear();

      const mainContainer = document.createElement('div');
      mainContainer.style.cssText = 'grid-column: 1 / -1; display: flex; flex-direction: column; gap: 2rem; width: 100%;';
      mainContainer.innerHTML = categories.map(renderRow).join('');
      this.grid.appendChild(mainContainer);

      // Auto-scan visible homepage items for 404 links in background
      categories.forEach(cat => {
        if (fetchResults[cat.id]) {
          this.scanFeedForBrokenVideos(fetchResults[cat.id]);
        }
      });

      const loadMoreContainer = document.getElementById('load-more-container');
      if (loadMoreContainer) loadMoreContainer.style.display = 'none';
      const paginationContainer = document.getElementById('pagination-container');
      if (paginationContainer) paginationContainer.style.display = 'none';

    } catch (e) {
      console.error(e);
    } finally {
      this._isLoadingFeed = false;
    }
  },

  /**
   * Update visibility of Load More and Pagination Controls
   */
  updatePaginationAndLoadMore() {
    const loadMoreContainer = document.getElementById('load-more-container');
    const paginationContainer = document.getElementById('pagination-container');

    if (this.singleCategoryMode) {
      if (loadMoreContainer) {
        loadMoreContainer.style.display = 'block';
        const btn = document.getElementById('load-more-btn');
        if (btn) btn.textContent = 'View More';
      }
      if (paginationContainer) paginationContainer.style.display = 'none';
      return;
    }

    if (this.renderedCount >= 100) {
      if (loadMoreContainer) loadMoreContainer.style.display = 'none';
      this.renderPagination();
      const pag = document.getElementById('pagination-container');
      if (pag) pag.style.display = 'flex';
    } else {
      if (loadMoreContainer) loadMoreContainer.style.display = 'block';
      if (paginationContainer) paginationContainer.style.display = 'none';
    }
  },

  /**
   * Render numbered pagination controls
   */
  renderPagination() {
    let container = document.getElementById('pagination-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'pagination-container';
      container.className = 'pagination';
      this.grid.parentNode.insertBefore(container, this.grid.nextSibling);
    }

    const page = this.currentPage;

    container.innerHTML = `
      <button class="page-btn" id="page-prev" ${page === 1 ? 'disabled' : ''} onclick="App.goToPage(${page - 1})">
        <i class="fas fa-chevron-left"></i> Prev
      </button>
      <span style="color: white; font-weight: 600; margin: 0 1rem;">Page ${page}</span>
      <button class="page-btn" id="page-next" onclick="App.goToPage(${page + 1})">
        Next <i class="fas fa-chevron-right"></i>
      </button>
    `;
  },

  /**
   * Navigate to specific page
   */
  goToPage(page) {
    if (page < 1) return;
    this.currentPage = page;
    this.renderedCount = 0;
    this.grid.innerHTML = '';
    this.showSkeletons();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const loadMoreContainer = document.getElementById('load-more-container');
    if (loadMoreContainer) loadMoreContainer.style.display = 'none';
    const paginationContainer = document.getElementById('pagination-container');
    if (paginationContainer) paginationContainer.style.display = 'none';

    this.moviePage = Math.floor((page - 1) * 35 / 20) + 1;
    this.tvPage = Math.floor((page - 1) * 35 / 20) + 1;
    this.animePage = Math.floor((page - 1) * 35 / 20) + 1;
    this.moviePool = [];
    this.tvPool = [];
    this.animePool = [];

    this.fetchAndRenderBatch();
  },

  /**
   * Show skeleton state
   */
  showSkeletons() {
    if (this.singleCategoryMode === 'combined') {
      this.grid.innerHTML = `
        <div style="grid-column: 1 / -1; display: flex; flex-direction: column; gap: 2rem; width: 100%;">
          ${Array(6).fill(`
            <div style="display: flex; flex-direction: column; gap: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">
                <div class="skeleton" style="width: 150px; height: 1.5rem; border-radius: 4px; background: rgba(255,255,255,0.05);"></div>
                <div class="skeleton" style="width: 80px; height: 1.5rem; border-radius: 4px; background: rgba(255,255,255,0.05);"></div>
              </div>
              <div style="display: flex; gap: 1rem; overflow: hidden; padding-bottom: 0.8rem;">
                ${Array(8).fill('<div class="movie-card skeleton" style="flex: 0 0 150px; width: 150px; height: 225px;"></div>').join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      this.grid.innerHTML = Array(12).fill('<div class="movie-card skeleton"></div>').join('');
    }
  },

  /**
   * Search results handler: query movies, series, and anime, display in separate container
   */
  async handleSearch() {
    const resultsSection = document.getElementById('search-results-section');
    const mainFeedSection = document.getElementById('main-feed-section');
    const resultsGrid = document.getElementById('search-results-container');
    const loadMoreContainer = document.getElementById('load-more-container');
    const paginationContainer = document.getElementById('pagination-container');

    if (!this.searchQuery) {
      if (resultsSection) resultsSection.style.display = 'none';
      if (mainFeedSection) mainFeedSection.style.display = 'block';
      this.updatePaginationAndLoadMore();
      return;
    }

    if (resultsSection) resultsSection.style.display = 'block';
    if (mainFeedSection) mainFeedSection.style.display = 'none';
    if (loadMoreContainer) loadMoreContainer.style.display = 'none';
    if (paginationContainer) paginationContainer.style.display = 'none';

    if (resultsGrid) {
      resultsGrid.innerHTML = Array(6).fill('<div class="movie-card skeleton"></div>').join('');
    }

    try {
      const searchType = this.animeSubFilter === 'cartoon' ? 'cartoon' : 'anime';
      const anime = await API.getMovies(searchType, 'trending', 1, this.searchQuery, '');
      // DB search results use 'poster' field (not 'poster_path') and 'genres' (not 'genre_ids')
      let aList = (anime && anime.results) ? anime.results.filter(m => m.poster || m.poster_path) : [];
      aList = aList.filter(item => {
        const isItemAnime = this.isAnime(item);
        return this.animeSubFilter === 'anime' ? isItemAnime : !isItemAnime;
      });

      const allResults = aList.map(item => {
        const typeVal = item.type || (item.title ? 'movie' : 'tv');
        return { ...item, type: typeVal };
      });

      // Strong ID and Title de-duplication
      const uniqueResults = [];
      const seenIds = new Set();
      const seenTitles = new Set();
      allResults.forEach(r => {
        const id = String(r.id);
        const title = (r.title || r.name || '').toLowerCase().trim();
        if (!seenIds.has(id) && !seenTitles.has(title)) {
          seenIds.add(id);
          seenTitles.add(title);
          uniqueResults.push(r);
        }
      });

      // Fuse.js Fuzzy Search Integration
      let finalResults = [];
      if (typeof Fuse !== 'undefined') {
        const fuse = new Fuse(uniqueResults, {
          keys: [
            { name: 'title', weight: 0.7 },
            { name: 'name', weight: 0.7 },
            { name: 'original_title', weight: 0.3 },
            { name: 'overview', weight: 0.2 }
          ],
          threshold: 0.4,
          distance: 100
        });
        finalResults = this.filterHidden(fuse.search(this.searchQuery).map(res => res.item));
      } else {
        const queryLower = this.searchQuery.toLowerCase().trim();
        finalResults = this.filterHidden(uniqueResults.filter(item => {
          const title = (item.title || item.name || '').toLowerCase();
          return title.includes(queryLower);
        }));
      }

      if (finalResults.length === 0) {
        resultsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 5rem; color: #666; font-size:1.5rem;">No results found.</div>';
        if (resultsSection) {
          resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }

      resultsGrid.innerHTML = finalResults.map(m => {
        const title = m.title || m.name || 'Unknown';
        const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const year = m.release_year
          ? String(m.release_year)
          : (m.release_date || m.first_air_date || '????').split('-')[0];
        const rawRating = m.rating || m.vote_average;
        const rating = (rawRating && parseFloat(rawRating) > 0) ? parseFloat(rawRating).toFixed(1) : '7.5';
        const poster = m.poster
          ? m.poster
          : (m.poster_path
            ? (m.poster_path.startsWith('http') ? m.poster_path : 'https://image.tmdb.org/t/p/w500' + m.poster_path)
            : 'https://placehold.co/500x750?text=No+Poster');
        const posterSm = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w185/') : poster;
        const posterMd = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w342/') : poster;

        const contentType = this.getContentType(m, m.type);

        return `
          <div class="movie-card fade-in" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${m.type}', true, false, ${m.netmirror ? 'true' : 'false'})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle}">
            <span class="type-badge" aria-hidden="true">${contentType}</span>
            <img
              src="${poster}"
              srcset="${posterSm} 185w, ${posterMd} 342w, ${poster} 500w"
              sizes="(max-width:480px) 160px, (max-width:768px) 200px, 240px"
              alt="${safeTitle} poster"
              loading="lazy"
              decoding="async"
              width="500"
              height="750"
              onload="this.parentElement.classList.add('loaded')"
              onerror="this.src='https://placehold.co/500x750?text=No+Poster'; this.parentElement.classList.add('loaded');"
            >
            <div class="movie-card-info">
              <h4 class="movie-title">${safeTitle}</h4>
              <div class="movie-meta">
                <span><i class="fas fa-star rating-star" aria-hidden="true"></i> ${rating}</span>
                <span>${year}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Auto-scan visible search results for 404 links in background
      this.scanFeedForBrokenVideos(finalResults);

      if (resultsSection) {
        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

    } catch (e) {
      console.error(e);
      if (resultsGrid) resultsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 5rem; color: #666; font-size:1.5rem;">Search failed.</div>';
    }
  },

  populateModalUI(movie, type, isNetMirror, movieId) {
    // Reset sound toggle UI at modal open
    const soundToggle = document.getElementById('sound-toggle');
    if (soundToggle) {
      soundToggle.querySelector('span').textContent = 'Muted';
      soundToggle.querySelector('i').className = 'fas fa-volume-mute';
    }

    // Display poster — ToonStream records use `.poster`, admin entries may use `.poster_path`
    const posterSrc = movie.poster
      ? movie.poster
      : (movie.poster_path
        ? (movie.poster_path.startsWith('http') ? movie.poster_path : 'https://image.tmdb.org/t/p/w500' + movie.poster_path)
        : 'https://placehold.co/500x750?text=No+Poster');
    document.getElementById('modal-poster').src = posterSrc;
    document.getElementById('modal-title').textContent = this.decodeHtmlEntities(movie.title || movie.name);

    const ratingVal = movie.vote_average || movie.rating || 7.5;
    const ratingHtml = `<i class="fas fa-star rating-star"></i> ${parseFloat(ratingVal).toFixed(1)}`;
    const yearHtml = `<i class="far fa-calendar-alt"></i> ${(movie.release_date || movie.first_air_date || '????').split('-')[0]}`;

    document.getElementById('modal-rating').innerHTML = ratingHtml;
    document.getElementById('modal-year').innerHTML = yearHtml;

    const mobRating = document.getElementById('modal-rating-mobile');
    const mobYear = document.getElementById('modal-year-mobile');
    if (mobRating) mobRating.innerHTML = ratingHtml;
    if (mobYear) mobYear.innerHTML = yearHtml;

    const descRaw = movie.overview || movie.description || 'No description available.';
    const descText = this.decodeHtmlEntities(descRaw);
    const descEl = document.getElementById('modal-description');
    const descToggle = document.getElementById('modal-desc-toggle');

    if (descEl) {
      descEl.textContent = descText;
      descEl.classList.remove('expanded');
    }

    if (descToggle) {
      if (descText.length > 200) {
        descToggle.style.display = 'inline-block';
        descToggle.textContent = 'View More';
        descToggle.onclick = () => {
          if (descEl.classList.contains('expanded')) {
            descEl.classList.remove('expanded');
            descToggle.textContent = 'View More';
          } else {
            descEl.classList.add('expanded');
            descToggle.textContent = 'View Less';
          }
        };
      } else {
        descToggle.style.display = 'none';
      }
    }

    this.updateMetaTags(movie, type);

    const langEl = document.getElementById('modal-language');
    if (langEl) {
      const isHindi = this.isHindiDubbed(movie) || movie.original_language === 'hi';
      langEl.style.display = isHindi ? '' : 'none';
      if (isHindi) langEl.innerHTML = '<i class="fas fa-language" aria-hidden="true"></i> <span class="sr-only">Language:</span> Hindi Dubbed';
    }

    const wishlistBtn = document.getElementById('modal-wishlist-btn');
    if (wishlistBtn) {
      const favs = JSON.parse(localStorage.getItem('moviebox_favorites') || '[]');
      const isFav = favs.some(f => f.id === movie.id);
      if (isFav) {
        wishlistBtn.classList.add('added');
        wishlistBtn.innerHTML = '<i class="fas fa-heart"></i> Remove Wishlist';
      } else {
        wishlistBtn.classList.remove('added');
        wishlistBtn.innerHTML = '<i class="far fa-heart"></i> Add to Wishlist';
      }

      wishlistBtn.onclick = () => {
        const currentFavs = JSON.parse(localStorage.getItem('moviebox_favorites') || '[]');
        const index = currentFavs.findIndex(f => f.id === movie.id);
        if (index !== -1) {
          currentFavs.splice(index, 1);
          wishlistBtn.classList.remove('added');
          wishlistBtn.innerHTML = '<i class="far fa-heart"></i> Add to Wishlist';
        } else {
          currentFavs.push(movie);
          wishlistBtn.classList.add('added');
          wishlistBtn.innerHTML = '<i class="fas fa-heart"></i> Remove Wishlist';
        }
        localStorage.setItem('moviebox_favorites', JSON.stringify(currentFavs));
      };
    }

    const watchBtn = document.getElementById('modal-watch-btn');
    if (watchBtn) {
      watchBtn.onclick = () => {
        this.openModal(movieId, type, true, true, isNetMirror);
      };
    }

    const backBtn = document.getElementById('back-to-details');
    if (backBtn) {
      backBtn.onclick = () => {
        // Smooth in-place switch back to details (no full reload)
        if (this.activePlayer) {
          this.activePlayer.destroy();
          this.activePlayer = null;
        }
        if (this.playerMessageHandler) {
          window.removeEventListener('message', this.playerMessageHandler);
          this.playerMessageHandler = null;
        }
        const trailerContainer = document.getElementById('trailer-container');
        if (trailerContainer) trailerContainer.innerHTML = '';

        const body = document.querySelector('.modal-body');
        const hero = document.querySelector('.modal-hero');
        const controlBar = document.getElementById('player-control-bar');
        const soundToggle = document.getElementById('sound-toggle');
        const heroOverlay = document.querySelector('.modal-hero-overlay');
        const noTrailerEl = document.getElementById('no-trailer');
        const modalSeoEl = document.getElementById('modal-seo-content');

        this.modal.classList.remove('watching');
        if (body) body.style.display = 'flex';
        if (hero) { hero.style.height = ''; hero.style.display = ''; }
        if (controlBar) controlBar.style.display = 'none';
        if (heroOverlay) heroOverlay.style.display = 'block';
        if (backBtn) backBtn.style.display = 'none';
        if (modalSeoEl) modalSeoEl.style.display = 'block';

        const playerAd = document.getElementById('player-ad-overlay');
        if (playerAd) playerAd.style.display = 'none';

        // Restore trailer or show no-trailer ad smoothly
        const hasTrailer = !!movie._trailerUrl;
        if (hasTrailer) {
          if (soundToggle) soundToggle.style.display = 'flex';
          if (trailerContainer) trailerContainer.innerHTML = `<iframe id="trailer-video" src="${movie._trailerUrl}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
          this.hideNoTrailer(noTrailerEl);
        } else {
          if (soundToggle) soundToggle.style.display = 'none';
          if (trailerContainer) trailerContainer.innerHTML = '';
          this.showNoTrailer(noTrailerEl, 'TRAILER NOT AVAILABLE');
        }

        // Restore watch button
        const wb = document.getElementById('modal-watch-btn');
        if (wb) { wb.disabled = false; wb.innerHTML = '<i class="fas fa-play"></i> Watch Now'; }

        // Update URL back to details path
        const detailsPath = `/media/${type}/${movieId}`;
        if (window.location.pathname !== detailsPath) {
          window.history.pushState({}, '', detailsPath);
        }

        // Scroll modal to top smoothly
        const modalContent = this.modal.querySelector('.modal-content');
        if (modalContent) modalContent.scrollTo({ top: 0, behavior: 'smooth' });
      };
    }

    // Populate Modal SEO & FAQ Area — only shown in details mode (not while watching)
    const modalSeo = document.getElementById('modal-seo-content');
    if (modalSeo) {
      const animeTitle = this.decodeHtmlEntities(movie.title || movie.name || '');
      const animeDesc = this.decodeHtmlEntities(movie.overview || movie.description || '');
      const faqList = [
        {
          name: `Where to watch ${animeTitle} in Hindi dubbed?`,
          text: `You can stream ${animeTitle} in Hindi dubbed online free on CineStream. Enjoy dual audio options with high quality 1080p HD video. No subscription or registration required.`
        },
        {
          name: `Is ${animeTitle} available in Hindi on CineStream?`,
          text: `Yes! ${animeTitle} is available with Hindi dubbed audio track on CineStream. You can watch all seasons and full episodes free.`
        },
        {
          name: `What is the story of ${animeTitle}?`,
          text: animeDesc || `Stream ${animeTitle} dubbed in Hindi online. Explore the full story, characters, and episodes on CineStream.`
        }
      ];

      const visibleSeoContent = `
        <div class="ssr-seo-modal-inner" itemscope itemtype="https://schema.org/FAQPage" style="color:var(--text);font-family:system-ui,-apple-system,sans-serif;">
          <h3 style="font-size:1.2rem;font-weight:700;margin:0 0 0.75rem;color:var(--primary);">Frequently Asked Questions (FAQs)</h3>
          <div style="line-height:1.6;font-size:0.9rem;">
            ${faqList.map(faq => `
              <div itemprop="mainEntity" itemscope itemtype="https://schema.org/Question" style="margin-bottom:1rem;">
                <strong itemprop="name" class="faq-question" style="color:var(--text);display:block;margin-bottom:0.25rem;">Q: ${faq.name}</strong>
                <div itemprop="acceptedAnswer" itemscope itemtype="https://schema.org/Answer">
                  <span itemprop="text" class="faq-answer" style="color:var(--text-muted);display:block;padding-left:1rem;border-left:2px solid var(--primary);">${faq.text}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;

      modalSeo.innerHTML = visibleSeoContent;
      modalSeo.style.display = 'block';
    }
  },

  /**
   * Modal Logic
   */
  async openModal(movieId, type, updateHistory = true, isWatching = false, isNetMirror = false) {


    if (updateHistory) {
      const newPath = isWatching ? `/watch/${type}/${movieId}` : `/media/${type}/${movieId}`;
      if (window.location.pathname !== newPath) {
        window.history.pushState({ movieId, type, isWatching }, '', newPath);
      }
    }
    this.activeMovieId = movieId;

    document.getElementById('modal-title').textContent = 'Loading...';
    this.modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Show loading screen with scroll reset and CSS class trigger
    const loadingScreen = document.getElementById('modal-loading-screen');
    const modalContent = this.modal.querySelector('.modal-content');
    if (loadingScreen) {
      if (modalContent) {
        modalContent.scrollTop = 0;
        modalContent.style.overflowY = 'hidden';
      }
      loadingScreen.classList.add('active');
    }

    try {
      let movie;
      const soundToggle = document.getElementById('sound-toggle');
      const backBtn = document.getElementById('back-to-details');

      // Sync admin cache in background (respects throttle and uses local storage cache if available)
      this.syncDatabaseCache(false).catch(() => { });

      const adminStore = this.adminCache || {};
      const getLocalMovie = () => {
        if (adminStore[movieId] || adminStore[String(movieId)]) {
          return adminStore[movieId] || adminStore[String(movieId)];
        }
        if (this.animeDetailsCache[movieId]) {
          return this.animeDetailsCache[movieId];
        }
        // Find in local memory pools
        const local = (this.movies && this.movies.find(m => String(m.id) === String(movieId))) ||
          (this.moviePool && this.moviePool.find(m => String(m.id) === String(movieId))) ||
          (this.tvPool && this.tvPool.find(m => String(m.id) === String(movieId))) ||
          (this.animePool && this.animePool.find(m => String(m.id) === String(movieId))) ||
          (this.freshDropPool && this.freshDropPool.find(m => String(m.id) === String(movieId))) ||
          (this.upcomingPool && this.upcomingPool.find(m => String(m.id) === String(movieId))) ||
          (this.animeSeriesPool && this.animeSeriesPool.find(m => String(m.id) === String(movieId))) ||
          (this.animeMoviesPool && this.animeMoviesPool.find(m => String(m.id) === String(movieId))) ||
          (this.cartoonSeriesPool && this.cartoonSeriesPool.find(m => String(m.id) === String(movieId))) ||
          (this.cartoonMoviesPool && this.cartoonMoviesPool.find(m => String(m.id) === String(movieId)));
        if (local) {
          return {
            id: local.id,
            title: local.title || local.name,
            name: local.title || local.name,
            poster: local.poster || (local.poster_path ? (local.poster_path.startsWith('http') ? local.poster_path : 'https://image.tmdb.org/t/p/w500' + local.poster_path) : 'https://placehold.co/500x750?text=No+Poster'),
            poster_path: local.poster_path || null,
            banner: local.banner || local.poster,
            overview: local.overview || local.description || 'Loading details...',
            vote_average: parseFloat(local.vote_average || local.rating || '7.5'),
            release_date: local.release_date || (local.release_year ? `${local.release_year}-01-01` : ''),
            first_air_date: local.first_air_date || (local.release_year ? `${local.release_year}-01-01` : ''),
            genres: Array.isArray(local.genres) ? local.genres.map(g => typeof g === 'string' ? { name: g } : g) : [],
            type: local.type || (local.title ? 'movie' : 'tv'),
            status: local.status || 'Loading...',
            duration: local.duration || '',
            language: local.language || 'Hindi / English',
            slug: local.slug || '',
            seasonCount: local.seasonCount || 1,
            episodeCount: local.episodeCount || 0,
            related: local.related || [],
            recommendations: local.recommendations || []
          };
        }
        return null;
      };

      // 1. Check if we have local movie data to load instantly
      let localMovie = getLocalMovie();
      if (localMovie) {
        movie = localMovie;
        this.populateModalUI(movie, type, isNetMirror, movieId);

        // Hide loading screen instantly!
        const loadingScreen = document.getElementById('modal-loading-screen');
        const modalContent = this.modal.querySelector('.modal-content');
        if (loadingScreen) {
          loadingScreen.classList.remove('active');
          if (modalContent) {
            modalContent.style.overflowY = '';
          }
        }
      }

      // 2. Fetch full details from server
      if (!localMovie || (!localMovie.description && !localMovie.overview) || !this.animeDetailsCache[movieId]) {
        try {
          const fetchPromise = fetch(`/api/v1/anime/details?id=${encodeURIComponent(movieId)}`).then(r => r.json());

          if (!localMovie) {
            // Blocking fetch if we have absolutely no local data
            const detailsRes = await fetchPromise;
            if (detailsRes && detailsRes.id) {
              movie = {
                id: detailsRes.id,
                title: detailsRes.title,
                name: detailsRes.title,
                poster: detailsRes.poster || 'https://placehold.co/500x750?text=No+Poster',
                poster_path: null,
                banner: detailsRes.banner,
                overview: detailsRes.description || 'No description available.',
                vote_average: parseFloat(detailsRes.rating || '7.5'),
                release_date: detailsRes.release_year ? `${detailsRes.release_year}-01-01` : '',
                first_air_date: detailsRes.release_year ? `${detailsRes.release_year}-01-01` : '',
                genres: (detailsRes.genres || []).map(g => ({ name: g })),
                type: detailsRes.type,
                status: detailsRes.status,
                duration: detailsRes.duration,
                language: detailsRes.language,
                slug: detailsRes.slug,
                seasonCount: detailsRes.seasonCount || 1,
                episodeCount: detailsRes.episodeCount || 0,
                related: detailsRes.related || [],
                recommendations: detailsRes.recommendations || [],
                _isToonStream: true
              };
              this.animeDetailsCache[movieId] = movie;
              this.populateModalUI(movie, type, isNetMirror, movieId);

              const loadingScreen = document.getElementById('modal-loading-screen');
              const modalContent = this.modal.querySelector('.modal-content');
              if (loadingScreen) {
                loadingScreen.classList.remove('active');
                if (modalContent) {
                  modalContent.style.overflowY = '';
                }
              }
            } else {
              throw new Error('Anime not found in database.');
            }
          } else {
            // Asynchronous fetch in the background to update detail fields (like episodes) smoothly
            fetchPromise.then(detailsRes => {
              if (detailsRes && detailsRes.id && this.activeMovieId === movieId) {
                const updatedMovie = {
                  id: detailsRes.id,
                  title: detailsRes.title,
                  name: detailsRes.title,
                  poster: detailsRes.poster || 'https://placehold.co/500x750?text=No+Poster',
                  poster_path: null,
                  banner: detailsRes.banner,
                  overview: detailsRes.description || 'No description available.',
                  vote_average: parseFloat(detailsRes.rating || '7.5'),
                  release_date: detailsRes.release_year ? `${detailsRes.release_year}-01-01` : '',
                  first_air_date: detailsRes.release_year ? `${detailsRes.release_year}-01-01` : '',
                  genres: (detailsRes.genres || []).map(g => ({ name: g })),
                  type: detailsRes.type,
                  status: detailsRes.status,
                  duration: detailsRes.duration,
                  language: detailsRes.language,
                  slug: detailsRes.slug,
                  seasonCount: detailsRes.seasonCount || 1,
                  episodeCount: detailsRes.episodeCount || 0,
                  related: detailsRes.related || [],
                  recommendations: detailsRes.recommendations || [],
                  _isToonStream: true
                };
                this.animeDetailsCache[movieId] = updatedMovie;

                // Only overwrite if user is still on the same modal
                if (this.activeMovieId === movieId) {
                  movie = updatedMovie;
                  this.populateModalUI(movie, type, isNetMirror, movieId);

                  // Also re-render episodes selectors if currently watching
                  if (isWatching && typeof updateEpisodesList === 'function') {
                    updateEpisodesList();
                  }
                }
              }
            }).catch(err => console.warn("Background details fetch failed:", err));
          }
        } catch (err) {
          console.error("Failed loading movie details:", err);
          const loadingScreen = document.getElementById('modal-loading-screen');
          if (loadingScreen) {
            loadingScreen.classList.remove('active');
          }
          this.closeModal(true);
          this.showToast("Failed to load movie details. Please try again later.");
          if (!localMovie) return;
        }
      }

      const trailerContainer = document.getElementById('trailer-container');
      const noTrailer = document.getElementById('no-trailer');
      const heroOverlay = document.querySelector('.modal-hero-overlay');

      if (trailerContainer) {
        trailerContainer.innerHTML = '';
      }
      if (noTrailer) this.hideNoTrailer(noTrailer);

      if (isWatching) {
        this.modal.classList.add('watching');
        this.addToRecentlyViewed(movie, type);
        this.renderRecentlyViewed();
        if (soundToggle) soundToggle.style.display = 'none';
        if (backBtn) backBtn.style.display = 'flex';
        if (heroOverlay) heroOverlay.style.display = 'none';

        // Show player ad overlay when starting to watch
        const playerAd = document.getElementById('player-ad-overlay');
        if (playerAd) {
          playerAd.style.display = 'flex';
        }

        if (movieId) {
          const { STREAM_PLAYER_URL } = window.API_CONFIG;
          const title = movie.title || movie.name || '';
          let updateEpisodesList = null;

          // Snapshot the active movie ID for stale-data guards
          const thisMovieId = movieId;
          const isStale = () => thisMovieId !== this.activeMovieId;

          // Also clear the selector container so old options don't flash
          const customSelectorContainer = document.getElementById('custom-episode-selectors');
          if (customSelectorContainer) {
            customSelectorContainer.innerHTML = '';
            customSelectorContainer.style.display = 'none';
          }

          // Clean up old active player if exists
          if (this.activePlayer) {
            this.activePlayer.destroy();
            this.activePlayer = null;
          }

          // Initialize active player
          this.activePlayer = new StreamPlayer(trailerContainer, {
            movieId: movieId,
            title: title,
            onError: () => {
              const currentS = this.activePlayer ? this.activePlayer.currentSeason || 1 : 1;
              const currentE = this.activePlayer ? this.activePlayer.currentEpisode || 1 : 1;
              this.reportBrokenVideo(movieId, type, title, movie.poster_path, movie.release_date || movie.first_air_date, currentS, currentE);
            },
            onReady: (index, label) => {
              const serverSelect = document.getElementById('player-server-select');
              if (serverSelect) {
                serverSelect.value = index;
              }
            },
            onRefreshSource: async (source, playerInstance) => {
              try {
                if (movie.subjectid && movie.dp) {
                  const currentS = playerInstance.currentSeason || 1;
                  const currentE = playerInstance.currentEpisode || 1;
                  const resolveUrl = `/api/v1/resolve-netmirror?id=${movie.subjectid}&dp=${encodeURIComponent(movie.dp || '')}&title=${encodeURIComponent(movie.title)}&se=${type === 'movie' ? 0 : currentS}&ep=${type === 'movie' ? 0 : currentE}`;
                  console.log("[DEBUG] Refreshing expired NetMirror URL:", resolveUrl);
                  const resolveRes = await fetch(resolveUrl).then(r => r.json());
                  if (resolveRes && resolveRes.url) {
                    return resolveRes.url;
                  }
                }
              } catch (err) {
                console.error("[DEBUG] Error during NetMirror URL refresh callback:", err);
              }
              return null;
            }
          });

          // Episode sources are pre-crawled and stored in MongoDB.
          // Retrieval is handled inside playWithFailover via /api/v1/episodes.

          const adminStore = this.adminCache || {};
          const customEntry = adminStore[movieId] || adminStore[String(movieId)] || {};

          let hasCustom = false;
          if (type === 'movie') {
            hasCustom = !!customEntry.customLink;
          } else {
            hasCustom = !!((customEntry.customLinks && Object.keys(customEntry.customLinks).length > 0) || customEntry.customLink);
          }

          const getFinalUrl = (serverVal, s = 1, e = 1) => {
            const imdbId = movie.imdb_id || movie.imdbId || '';
            if (serverVal === 'custom') {
              if (type === 'movie') {
                return customEntry.customLink || '';
              } else {
                const customLinks = customEntry.customLinks || {};
                return customLinks[`S${s}E${e}`] || customEntry.customLink || '';
              }
            } else if (serverVal === '9xmovies') {
              if (this.isAnime(movie)) {
                return `https://9xmovielive.com/?s=${encodeURIComponent(title)}`;
              }
              const baseUrl = STREAM_PLAYER_URL || 'https://gemma416okl.com/play/';
              if (type === 'movie') {
                return `${baseUrl}${imdbId || movieId}`;
              } else {
                return `${baseUrl}${imdbId || movieId}/${s}/${e}`;
              }
            } else if (serverVal === 'netmirror') {
              const nmId = movie.netmirrorId || movieId;
              const directUrl = type === 'movie'
                ? `https://netmirror.global/movie/${nmId}/?embed=1`
                : `https://netmirror.global/tv/${nmId}/${s}/${e}/?embed=1`;
              return `/iframe-proxy?url=${encodeURIComponent(directUrl)}`;
            } else {
              return '';
            }
          };


          const playWithFailover = async (s = 1, e = 1) => {
            // Show player ad overlay on episode/source change
            const playerAd = document.getElementById('player-ad-overlay');
            if (playerAd) {
              playerAd.style.display = 'flex';
            }

            if (isWatching) {
              const url = new URL(window.location.href);
              url.searchParams.set('s', s);
              url.searchParams.set('e', e);
              window.history.replaceState(window.history.state, '', url.pathname + url.search);
            }

            if (this.activePlayer) {
              this.activePlayer._showLoading(`Season ${s} Episode ${e}`);
            }

            const cacheKey = `${movieId}_${s}_${e}`;
            if (this.episodeSourcesCache[cacheKey]) {
              const cachedSources = [...this.episodeSourcesCache[cacheKey]];
              const defaultPlayServer = localStorage.getItem('moviebox_default_play_server');
              if (defaultPlayServer) {
                const defaultIdx = cachedSources.findIndex(src => {
                  const cleanLabel = src.label.replace(/\s*\(Ads\)/gi, '').replace(/\s*\(No Ads\)/gi, '').trim();
                  return cleanLabel === defaultPlayServer.trim();
                });
                if (defaultIdx > -1) {
                  const [defaultSrc] = cachedSources.splice(defaultIdx, 1);
                  cachedSources.unshift(defaultSrc);
                }
              }

              if (this.activePlayer) {
                this.activePlayer.currentSeason = s;
                this.activePlayer.currentEpisode = e;
                await this.activePlayer.updateSources(cachedSources);
              }
              return;
            }
            const sources = [];

            // 1. Primary Source: Custom link from admin panel (trusted — skip health check & timeout)
            if (hasCustom) {
              const customUrl = getFinalUrl('custom', s, e);
              if (customUrl) {
                sources.push({ url: customUrl, type: 'iframe', label: 'Primary Link (Custom)', trusted: true });
              }
            }

            // 2. ToonStream Database Episode Sources — fetch specific episode (server caches per-episode)
            if (movie._isToonStream || movie.toonstreamId || (movie.id && String(movie.id).startsWith('toon_'))) {
              try {
                // Always fetch with the exact season+episode so the server scrapes the right sources
                const epsRes = await fetch(`/api/v1/episodes?animeId=${encodeURIComponent(movieId)}&season=${s}&episode=${e}`).then(r => r.json());
                const allEps = Array.isArray(epsRes) ? epsRes : [];
                const ep = allEps.find(ep => ep.season === s && ep.episode === e);
                if (ep && ep.sources && ep.sources.length > 0) {
                  const noAdsSources = [];
                  const adsSources = [];
                  let activeIdx = 1;
                  ep.sources.forEach(src => {
                    if (src.url) {
                      const cleanLabel = (src.label || '').replace(/\s*\(Ads\)/gi, '').replace(/\s*\(No Ads\)/gi, '').trim().toLowerCase();
                      const excludedServers = ['cloudy', 'multiq', 'short', 'sd', 'hd', 'fhd', 'watch/dl', 'gdmirrorbot', 'vidstream', 'vidstreaming'];
                      if (excludedServers.includes(cleanLabel)) {
                        return;
                      }

                      const isAdServer = src.label && (
                        src.label.includes('Server 4') ||
                        src.label.includes('Server 5') ||
                        src.label.includes('Server 7')
                      );

                      const isEmbed = src.url.includes('embed') ||
                        src.url.includes('/e/') ||
                        src.url.includes('rubystm') ||
                        src.url.includes('strmup') ||
                        src.url.includes('vidstreaming') ||
                        src.url.includes('streamruby');
                      const finalUrl = isEmbed
                        ? `/iframe-proxy?url=${encodeURIComponent(src.url)}`
                        : src.url;

                      const baseLabel = src.label || `Server ${activeIdx++}`;
                      if (isAdServer) {
                        adsSources.push({
                          url: finalUrl,
                          type: src.type || 'iframe',
                          label: `${baseLabel} (Ads)`,
                          allowAds: true,
                          hasAds: true
                        });
                      } else {
                        noAdsSources.push({
                          url: finalUrl,
                          type: src.type || 'iframe',
                          label: `${baseLabel} (No Ads)`,
                          allowAds: false,
                          hasAds: false
                        });
                      }
                    }
                  });
                  sources.push(...noAdsSources);
                  sources.push(...adsSources);
                }
              } catch (err) {
                console.warn('Could not load ToonStream episode sources from DB:', err);
              }
            } else {
              try {
                if (movie.subjectid && movie.dp) {
                  const resolveUrl = `/api/v1/resolve-netmirror?id=${movie.subjectid}&dp=${encodeURIComponent(movie.dp || '')}&title=${encodeURIComponent(movie.title)}&se=${type === 'movie' ? 0 : s}&ep=${type === 'movie' ? 0 : e}`;
                  const resolveRes = await fetch(resolveUrl).then(r => r.json());
                  if (resolveRes && resolveRes.url) {
                    sources.push({ url: resolveRes.url, type: 'mp4', label: 'NetMirror CDN', trusted: true });
                  }
                }
              } catch (err) {
                console.error("[DEBUG] NetMirror resolution error:", err);
              }
            }

            // Sort ToonStream servers numerically if generic, otherwise preserve their original scraped order
            const originalOrder = new Map(sources.map((src, i) => [src, i]));
            const getSortKey = (src) => {
              const match = src.label.match(/Server\s*(\d+)/i);
              return match ? parseInt(match[1], 10) : (1000 + originalOrder.get(src));
            };

            const customSources = sources.filter(src => src.label.includes('Custom'));
            const normalSources = sources.filter(src => !src.label.includes('Custom'));

            normalSources.sort((a, b) => {
              return getSortKey(a) - getSortKey(b);
            });

            // Reconstruct sources in counting order
            sources.length = 0;
            sources.push(...customSources, ...normalSources);

            if (sources.length > 0) {
              this.episodeSourcesCache[cacheKey] = [...sources];
            }

            // Reorder sources based on user's default server selection
            const defaultPlayServer = localStorage.getItem('moviebox_default_play_server');
            if (defaultPlayServer) {
              const defaultIdx = sources.findIndex(src => {
                const cleanLabel = src.label.replace(/\s*\(Ads\)/gi, '').replace(/\s*\(No Ads\)/gi, '').trim();
                return cleanLabel === defaultPlayServer.trim();
              });
              if (defaultIdx > -1) {
                const [defaultSrc] = sources.splice(defaultIdx, 1);
                sources.unshift(defaultSrc);
              }
            }

            if (this.activePlayer) {
              this.activePlayer.currentSeason = s;
              this.activePlayer.currentEpisode = e;
              await this.activePlayer.updateSources(sources);
              if (sources.length === 0) {
                this.reportBrokenVideo(movieId, type, title, movie.poster_path, movie.release_date || movie.first_air_date, s, e);
              }
            }
          };

          const showSelectors = movie.type !== 'movie' && movie.type !== 'movies';

          if (showSelectors) {
            if (customSelectorContainer) {
              customSelectorContainer.style.display = 'flex';

              // ── Load episode list from ToonStream database (episode metadata only, no sources) ──
              (async () => {
                if (isStale()) return;
                try {
                  // Fetch the episode list for the selector (sources are fetched per-episode in playWithFailover)
                  const epsRes = await fetch(`/api/v1/episodes?animeId=${encodeURIComponent(movieId)}&season=1&episode=1`).then(r => r.json());
                  const allEps = Array.isArray(epsRes) ? epsRes : [];
                  if (isStale()) return;

                  // Group by season
                  const seasonMap = {};
                  allEps.forEach(ep => {
                    const s = ep.season || 1;
                    if (!seasonMap[s]) seasonMap[s] = [];
                    seasonMap[s].push(ep);
                  });

                  // Get actual seasons list from seasonMap keys
                  const availableSeasons = Object.keys(seasonMap).map(Number).sort((a, b) => a - b);
                  if (availableSeasons.length === 0) {
                    availableSeasons.push(1);
                  }

                  let seasonOptions = '';
                  availableSeasons.forEach(s => {
                    seasonOptions += `<option value="${s}">Season ${s}</option>`;
                  });

                  customSelectorContainer.innerHTML = `
                    <select id="player-season-select" class="filter-dropdown-select glass" style="outline: none; border: 1px solid var(--glass-border); padding: 6px 12px; border-radius: 20px; color: white; background: #222; cursor: pointer; font-size: 0.85rem; font-family: 'Outfit', sans-serif; font-weight: 600;">
                      ${seasonOptions}
                    </select>
                    <select id="player-episode-select" class="filter-dropdown-select glass" style="outline: none; border: 1px solid var(--glass-border); padding: 6px 12px; border-radius: 20px; color: white; background: #222; cursor: pointer; font-size: 0.85rem; font-family: 'Outfit', sans-serif; font-weight: 600;">
                    </select>
                  `;

                  const seasonSelect = document.getElementById('player-season-select');
                  const episodeSelect = document.getElementById('player-episode-select');

                  updateEpisodesList = async (seasonNum) => {
                    if (isStale()) return;
                    const sNum = parseInt(seasonNum, 10);
                    const eps = seasonMap[sNum] || [];
                    episodeSelect.innerHTML = eps.length > 0
                      ? eps.map(ep => `<option value="${ep.episode}">Episode ${ep.episode}</option>`).join('')
                      : '<option value="1">Episode 1</option>';
                  };

                  seasonSelect.onchange = async () => {
                    if (isStale()) return;
                    const sNum = parseInt(seasonSelect.value, 10);

                    // If this season's episodes aren't loaded yet, fetch them from API
                    if (!seasonMap[sNum] || seasonMap[sNum].length === 0) {
                      try {
                        const freshRes = await fetch(`/api/v1/episodes?animeId=${encodeURIComponent(movieId)}&season=${sNum}&episode=1`).then(r => r.json());
                        if (!isStale() && Array.isArray(freshRes)) {
                          // Merge new season episodes into seasonMap
                          freshRes.forEach(ep => {
                            const epS = ep.season || sNum;
                            if (!seasonMap[epS]) seasonMap[epS] = [];
                            if (!seasonMap[epS].find(e => e.episode === ep.episode)) {
                              seasonMap[epS].push(ep);
                            }
                          });
                          // Also ensure new season appears in the dropdown
                          const allSeasons = Object.keys(seasonMap).map(Number).sort((a, b) => a - b);
                          seasonSelect.innerHTML = allSeasons.map(s => `<option value="${s}"${s === sNum ? ' selected' : ''}>Season ${s}</option>`).join('');
                        }
                      } catch (e) {
                        console.warn('Could not fetch season episodes:', e);
                      }
                    }

                    await updateEpisodesList(sNum);
                    if (isStale()) return;

                    const firstEpOfSeason = seasonMap[sNum] && seasonMap[sNum][0] ? seasonMap[sNum][0].episode : 1;
                    episodeSelect.value = firstEpOfSeason;
                    await playWithFailover(sNum, firstEpOfSeason);
                  };

                  episodeSelect.onchange = async () => {
                    if (isStale()) return;
                    await playWithFailover(parseInt(seasonSelect.value, 10), parseInt(episodeSelect.value, 10));
                  };

                  const urlParams = new URLSearchParams(window.location.search);
                  const paramS = parseInt(urlParams.get('s'), 10);
                  const paramE = parseInt(urlParams.get('e'), 10);

                  let defaultSeason = availableSeasons[0] || 1;
                  if (!isNaN(paramS) && availableSeasons.includes(paramS)) {
                    defaultSeason = paramS;
                  }

                  if (seasonSelect) {
                    seasonSelect.value = defaultSeason;
                  }

                  await updateEpisodesList(defaultSeason);

                  // Restore watch button
                  if (this._watchBtnLoadTimeout) {
                    clearTimeout(this._watchBtnLoadTimeout);
                    this._watchBtnLoadTimeout = null;
                  }
                  const wb = document.getElementById('modal-watch-btn');
                  if (wb) { wb.disabled = false; wb.innerHTML = '<i class="fas fa-play"></i> Watch Now'; }

                  // Default episode option check
                  let defaultEpisodeVal = episodeSelect && episodeSelect.value ? parseInt(episodeSelect.value, 10) : 1;
                  if (!isNaN(paramE)) {
                    const eps = seasonMap[defaultSeason] || [];
                    if (eps.some(ep => ep.episode === paramE)) {
                      defaultEpisodeVal = paramE;
                    }
                  }

                  if (episodeSelect) {
                    episodeSelect.value = defaultEpisodeVal;
                  }

                  await playWithFailover(defaultSeason, defaultEpisodeVal);
                } catch (err) {
                  console.error('Failed to load episode list:', err);
                  playWithFailover(1, 1);
                }
              })();
            } else {
              playWithFailover(1, 1);
            }
          } else {
            if (customSelectorContainer) customSelectorContainer.style.display = 'none';
            playWithFailover(1, 1);
          }

          // Inject Download & "Report Broken" buttons cleanly
          const dlContainer = document.getElementById('player-download-container');
          if (dlContainer) {
            // PLACEHOLDER: Replace '#' with the path to your app file (e.g. '/app-release.apk' or direct link)
            const downloadUrl = '/public/CineStream.apk';
            dlContainer.innerHTML = `
              <a href="${downloadUrl}" download class="btn-primary" style="padding: 6px 12px; font-size: 0.85rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; font-weight: 600; box-shadow: 0 4px 12px rgba(229, 9, 20, 0.4); border: none; cursor: pointer; color: white;">
                <i class="fas fa-mobile-alt"></i> Download App
              </a>
              <select id="player-server-select" class="glass" 
                style="outline: none; border: 1px solid var(--glass-border); padding: 6px 12px; border-radius: 4px; color: white; background: #222; cursor: pointer; font-size: 0.85rem; font-family: 'Outfit', sans-serif; font-weight: 600; margin-left: 8px; display: none;">
              </select>
            `;
            const serverSelect = document.getElementById('player-server-select');
            if (serverSelect) {
              serverSelect.onchange = () => {
                const idx = parseInt(serverSelect.value, 10);
                if (this.activePlayer && this.activePlayer.sources[idx]) {
                  this.activePlayer._trySource(idx);
                }
              };
            }
          }
        } else {
          if (noTrailer) {
            this.showNoTrailer(noTrailer, 'STREAM NOT AVAILABLE');
          }
        }
      } else {
        if (this.modal) this.modal.classList.remove('watching');
        if (backBtn) backBtn.style.display = 'none';
        if (heroOverlay) heroOverlay.style.display = 'block';
        const playerAd = document.getElementById('player-ad-overlay');
        if (playerAd) playerAd.style.display = 'none';

        let trailerUrl = movie._trailerUrl;
        if (typeof trailerUrl === 'undefined') {
          trailerUrl = await API.getTrailer(movieId, type);
          movie._trailerUrl = trailerUrl;
        }

        if (trailerContainer && noTrailer) {
          if (trailerUrl) {
            if (soundToggle) soundToggle.style.display = 'flex';
            trailerContainer.innerHTML = `<iframe id="trailer-video" src="${trailerUrl}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
            this.hideNoTrailer(noTrailer);
          } else {
            trailerContainer.innerHTML = '';
            this.showNoTrailer(noTrailer, 'TRAILER NOT AVAILABLE');
            if (soundToggle) soundToggle.style.display = 'none';
          }
        }
      }

      const body = document.querySelector('.modal-body');
      const hero = document.querySelector('.modal-hero');
      const controlBar = document.getElementById('player-control-bar');
      const modalSeoEl = document.getElementById('modal-seo-content');
      if (body && hero) {
        if (isWatching) {
          body.style.display = 'none';
          hero.style.height = 'calc(100% - 50px)';
          hero.style.display = 'block'; // Bypass mobile hide rule
          if (controlBar) controlBar.style.display = 'flex';
          if (modalSeoEl) modalSeoEl.style.display = 'none';
        } else {
          body.style.display = 'flex';
          hero.style.height = ''; // Revert to stylesheet height rule
          hero.style.display = ''; // Revert to stylesheet display rule
          if (controlBar) controlBar.style.display = 'none';
          if (modalSeoEl) modalSeoEl.style.display = 'block';
        }
      }

      // Wait for content (poster & iframe) to be fully loaded and rendered
      // await waitForMedia();

      // Fade out loading screen and restore overflow
      const loadingScreen = document.getElementById('modal-loading-screen');
      const modalContent = this.modal.querySelector('.modal-content');
      if (loadingScreen) {
        loadingScreen.classList.remove('active');
        setTimeout(() => {
          if (modalContent) {
            modalContent.style.overflowY = '';
          }
        }, 300);
      }
    } catch (e) {
      console.error(e);
      const loadingScreen = document.getElementById('modal-loading-screen');
      const modalContent = this.modal.querySelector('.modal-content');
      if (loadingScreen) {
        loadingScreen.classList.remove('active');
        if (modalContent) {
          modalContent.style.overflowY = '';
        }
      }
      this.closeModal();
    }
  },

  reportBrokenVideo(movieId, type, title, posterPath, date, season = null, episode = null) {
    const id = String(movieId) + (season !== null && episode !== null ? `_S${season}E${episode}` : '');
    const displayTitle = title + (season !== null && episode !== null ? ` - Season ${season} Episode ${episode}` : '');
    const reportItem = {
      id: id,
      mediaId: String(movieId),
      type: type,
      title: displayTitle,
      posterPath: posterPath,
      date: date,
      reportedAt: new Date().toISOString(),
      season: season,
      episode: episode,
      customLink: ''
    };
    fetch('/api/v1/broken-videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reportItem)
    }).catch(err => console.error("Failed to report broken video to MongoDB:", err));
  },

  closeModal(updHistory = true) {
    this.activeMovieId = null; // Cancel all pending async callbacks
    const loadingScreen = document.getElementById('modal-loading-screen');
    const modalContent = this.modal.querySelector('.modal-content');
    if (loadingScreen) {
      loadingScreen.classList.remove('active');
      if (modalContent) {
        modalContent.style.overflowY = '';
      }
    }
    if (this._watchBtnLoadTimeout) {
      clearTimeout(this._watchBtnLoadTimeout);
      this._watchBtnLoadTimeout = null;
    }
    // Destroy active player
    if (this.activePlayer) {
      this.activePlayer.destroy();
      this.activePlayer = null;
    }
    // Restore watch button if it was in loading state
    const wb = document.getElementById('modal-watch-btn');
    if (wb) { wb.disabled = false; wb.innerHTML = '<i class="fas fa-play"></i> Watch Now'; }
    if (this.playerMessageHandler) {
      window.removeEventListener('message', this.playerMessageHandler);
      this.playerMessageHandler = null;
    }
    if (this.modal) {
      this.modal.classList.remove('active');
      this.modal.classList.remove('watching');
    }
    document.body.style.overflow = 'auto';
    const trailerContainer = document.getElementById('trailer-container');
    const noTrailer = document.getElementById('no-trailer');
    const backBtn = document.getElementById('back-to-details');
    const heroOverlay = document.querySelector('.modal-hero-overlay');
    // Reset ALL inline styles so CSS media queries take full control on next open
    const heroEl = document.querySelector('.modal-hero');
    const bodyEl = document.querySelector('.modal-body');
    if (heroEl) { heroEl.style.display = ''; heroEl.style.height = ''; }
    if (bodyEl) { bodyEl.style.display = ''; }

    if (trailerContainer) trailerContainer.innerHTML = '';
    if (noTrailer) this.hideNoTrailer(noTrailer);
    if (backBtn) backBtn.style.display = 'none';
    const controlBar = document.getElementById('player-control-bar');
    if (controlBar) controlBar.style.display = 'none';
    if (heroOverlay) heroOverlay.style.display = 'block';

    const playerAd = document.getElementById('player-ad-overlay');
    if (playerAd) playerAd.style.display = 'none';

    // Clear movie-specific SEO content from home page area
    const seoArea = document.getElementById('seo-content-area');
    if (seoArea) seoArea.innerHTML = '';

    // Reset modal SEO/FAQ area so stale content is not shown on next open
    const modalSeo = document.getElementById('modal-seo-content');
    if (modalSeo) {
      modalSeo.innerHTML = '';
      modalSeo.style.display = 'none';
    }

    // Reset description toggle
    const descEl = document.getElementById('modal-description');
    const descToggle = document.getElementById('modal-desc-toggle');
    if (descEl) { descEl.textContent = ''; descEl.classList.remove('expanded'); }
    if (descToggle) { descToggle.style.display = 'none'; descToggle.textContent = 'View More'; }

    if (updHistory) {
      if (window.location.pathname !== '/') {
        window.history.pushState({}, '', '/');
      }
    }
    this.resetMetaTags();
  },

  resetMetaTags() {
    const SITE = 'https://cinestream.watch';
    const title = 'CineStream — Watch Hindi Dubbed Anime Free Online';
    const desc = 'Watch Hindi Dubbed Anime online free on CineStream. Stream Naruto Hindi Dubbed, Demon Slayer Hindi Dubbed, One Piece in Hindi, Jujutsu Kaisen Hindi Dubbed and 1000+ more anime series in HD. Free, no login required.';
    const poster = `${SITE}/images/fav-icon.png`;
    const canonical = `${SITE}/`;

    document.title = title;
    this.setById('seo-title', 'textContent', title);
    this.setById('seo-desc', 'content', desc);
    this.setById('seo-canonical', 'href', canonical);
    this.setById('og-title', 'content', title);
    this.setById('og-desc', 'content', desc);
    this.setById('og-url', 'content', canonical);
    this.setById('og-image', 'content', poster);
    this.setById('tw-title', 'content', title);
    this.setById('tw-desc', 'content', desc);
    this.setById('tw-image', 'content', poster);

    // Clear dynamic JSON-LD
    const dyn = document.getElementById('ld-dynamic');
    if (dyn) dyn.textContent = '';
    const legacy = document.getElementById('moviebox-jsonld');
    if (legacy) legacy.remove();
  },

  toggleSound() {
    const btn = document.getElementById('sound-toggle');
    const isM = btn.querySelector('span').textContent === 'Muted';
    const iframe = document.getElementById('trailer-video');

    if (iframe && iframe.contentWindow) {
      const command = isM ? 'unMute' : 'mute';
      iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: command,
        args: []
      }), '*');
    }

    btn.querySelector('span').textContent = isM ? 'Unmuted' : 'Muted';
    btn.querySelector('i').className = isM ? 'fas fa-volume-up' : 'fas fa-volume-mute';
  },

  /**
   * Continue Watching Logic
   */
  addToRecentlyViewed(movie, mediaType) {
    // Store mediaType alongside the movie so the card click uses the correct type
    const entry = { ...movie, _mediaType: mediaType || (movie.title && !movie.name ? 'movie' : 'tv') };
    // Deduplicate by id — remove any existing entry for this id
    let list = this.recentlyViewed.filter(m => String(m.id) !== String(entry.id));
    list.unshift(entry);
    this.recentlyViewed = list.slice(0, 25);
    localStorage.setItem('recently_viewed', JSON.stringify(this.recentlyViewed));
  },

  renderRecentlyViewed() {
    const section = document.getElementById('recently-viewed-section');
    if (!this.recentlyViewed.length) {
      if (section) section.style.display = 'none';
      return;
    }

    if (section) section.style.display = 'block';
    const grid = document.getElementById('recently-viewed-grid');
    if (grid) {
      grid.innerHTML = this.recentlyViewed.map((m, idx) => {
        const cardType = m._mediaType || (m.title && !m.name ? 'movie' : 'tv');
        const title = m.title || m.name || '';
        const poster = m.poster
          ? m.poster
          : (m.poster_path
            ? (m.poster_path.startsWith('http') ? m.poster_path : 'https://image.tmdb.org/t/p/w500' + m.poster_path)
            : 'https://placehold.co/500x750?text=No+Poster');
        const posterSm = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w185/') : poster;
        const posterMd = poster.includes('image.tmdb.org') ? poster.replace('/w500/', '/w342/') : poster;
        const altText = `${title} ${cardType === 'movie' ? 'Movie' : 'TV Series'} poster`;
        return `
          <div class="movie-card" role="listitem" style="aspect-ratio: 2/3; flex: 0 0 auto; width: 150px; scroll-snap-align: start;" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${cardType}')" tabindex="0" onkeydown="if(event.key==='Enter'){this.click();}" aria-label="Continue watching ${title}">
             <img src="${poster}" srcset="${posterSm} 185w, ${posterMd} 342w, ${poster} 500w" sizes="(max-width: 480px) 150px, (max-width: 768px) 185px, 240px" alt="${altText}" loading="eager" fetchpriority="${idx < 6 ? 'high' : 'auto'}" decoding="sync" width="150" height="225" onload="this.parentElement.classList.add('loaded')" onerror="this.src='https://placehold.co/500x750?text=No+Poster'; this.parentElement.classList.add('loaded');">
             <div class="movie-card-info" style="padding: 0.5rem;"><h4 class="movie-title" style="font-size: 0.8rem;">${title}</h4></div>
          </div>
        `;
      }).join('');
    }
  },

  findBestCatalogMatch(tmdbTitle, catalog, season = null) {
    if (!catalog || catalog.length === 0) return null;

    let searchTitle = tmdbTitle;
    if (season) {
      const formats = [
        `${tmdbTitle} Season ${season}`,
        `${tmdbTitle} S${String(season).padStart(2, '0')}`
      ];
      for (let f of formats) {
        const match = this.findBestCatalogMatch(f, catalog);
        if (match) return match;
      }
    }

    const cleanTmdb = searchTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanTmdb) return null;

    const removeQualityTags = (str) => {
      return str
        .replace(/\b(hindi|english|tamil|telugu|dual audio|org|webrip|web-dl|bluray|720p|1080p|480p|hevc|x264|x265|esub|sub|dubbed|voice over|full movie|movie)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const targetClean = removeQualityTags(cleanTmdb);

    const exactMatch = catalog.find(item => {
      const cleanItem = removeQualityTags(item.cleanText || '');
      return cleanItem === targetClean;
    });
    if (exactMatch) return exactMatch;

    const prefixMatch = catalog.find(item => {
      const cleanItem = removeQualityTags(item.cleanText || '');
      return cleanItem.startsWith(targetClean);
    });
    if (prefixMatch) return prefixMatch;

    const tmdbWords = targetClean.split(' ');
    const containmentMatch = catalog.find(item => {
      const cleanItem = removeQualityTags(item.cleanText || '');
      const catalogWords = cleanItem.split(' ');
      for (let i = 0; i <= catalogWords.length - tmdbWords.length; i++) {
        let match = true;
        for (let j = 0; j < tmdbWords.length; j++) {
          if (catalogWords[i + j] !== tmdbWords[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    });

    return containmentMatch || null;
  },

  getContentType(item, fallbackType) {
    if (!item) return 'Anime';

    const typeVal = item.type || fallbackType || '';
    if (typeVal === 'movie' || typeVal === 'movies') {
      return 'Anime Movie';
    }
    if (this.isAnime(item)) {
      return 'Anime';
    }
    return 'Cartoon';
  },

  isHindiDubbed(item) {
    if (!item) return false;
    if (item.original_language === 'hi') return true;
    const customStore = this.adminCache || {};
    if (item.id && customStore[item.id] && (customStore[item.id].original_language === 'hi' || customStore[item.id].hindi === true)) {
      return true;
    }
    const hindiStore = this.hindiCache || {};
    if (item.id && hindiStore[item.id] && hindiStore[item.id].link) {
      return true;
    }
    return false;
  },

  isAnime(item) {
    if (!item) return false;

    // 1. Support legacy TMDB/admin entries
    if (item.original_language === 'ja') return true;

    // 2. Check genres array
    const genres = Array.isArray(item.genres)
      ? item.genres.map(g => typeof g === 'object' ? (g.name || '') : String(g))
      : [];
    const hasAnimeGenre = genres.some(g => {
      const gl = g.toLowerCase();
      return gl.includes('anime') || gl.includes('japanese') || gl.includes('japaneses');
    });
    if (hasAnimeGenre) return true;

    // 3. Check language field
    const lang = String(item.language || '').toLowerCase();
    if (lang.includes('jap')) return true;

    // 4. Check tags array
    const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).toLowerCase()) : [];
    const hasAnimeTag = tags.some(t => t.includes('anime') || t.includes('japanese') || t.includes('japaneses'));
    if (hasAnimeTag) return true;

    return false;
  },

  /**
   * checkMissingCatalog — now uses server-side catalog service.
   * No longer downloads the 3.7MB JSON files to the client.
   */
  async checkMissingCatalog(items) {
    if (this.currentFilter === 'upcoming') return;
    if (!items || !Array.isArray(items)) return;

    const nowStr = new Date().toISOString().split('T')[0];
    const adminStore = this.adminCache || {};

    // Process items in batches to avoid overwhelming the server
    for (const m of items) {
      const id = m.id;
      const title = m.title || m.name || '';
      const releaseDate = m.release_date || m.first_air_date;

      if (releaseDate && releaseDate > nowStr) continue;
      if (adminStore[id] && (adminStore[id].customLink || adminStore[id].customLinks)) continue;

      const contentType = this.getContentType(m, m.title ? 'movie' : 'tv');
      if (contentType === 'Anime') continue;

      // Use server-side catalog check (no 3.7MB client download!)
      const result = await API.checkCatalog(title, id);

      if (!result.inCatalog) {
        const mediaType = m.title ? 'movie' : 'tv';
        fetch('/api/v1/missing-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            id: String(id), type: mediaType, title,
            posterPath: m.poster_path, date: releaseDate
          })
        }).catch(() => { });
      }
    }
  },

  scanFeedForBrokenVideos(items) {
    // Disabled to drastically reduce serverless function calls, bandwidth, and Vercel datapoints.
    return;
  },

  /**
   * Dynamic SEO System
   * Updates meta, canonical, OG, Twitter, JSON-LD, and modal breadcrumb
   * on every modal open. Domain: cinestream.watch
   */
  updateMetaTags(m, type) {
    const SITE = 'https://cinestream.watch';
    const IMG_BASE = 'https://image.tmdb.org/t/p/w780';
    const title = this.decodeHtmlEntities(m.title || m.name || 'CineStream');
    const year = (m.release_date || m.first_air_date || '').split('-')[0] || '';
    const overview = m.overview || '';
    const genres = m.genres ? m.genres.map(g => g.name).join(', ') : (m.genres_str || '');
    const poster = m.poster_path
      ? (m.manual && m.poster_path.startsWith('http') ? m.poster_path : IMG_BASE + m.poster_path)
      : `${SITE}/images/fav-icon.png`;
    const category = type === 'movie' ? 'movie' : 'tv';
    const canonical = `${SITE}/media/${category}/${m.id}`;
    const watchUrl = `${SITE}/watch/${category}/${m.id}`;

    const isToon = m._isToonStream || m.toonstreamId || (m.id && String(m.id).startsWith('toon_'));
    const suffix = isToon ? ' Hindi Dubbed (Watch in Hindi)' : '';

    // Meta description: max 155 chars, keyword-rich for anime search queries
    let metaDesc = '';
    if (isToon) {
      const base = `Watch ${title} Hindi Dubbed free online on CineStream. Stream all episodes of ${title} in Hindi with HD quality. No registration needed.`;
      metaDesc = base.length > 155 ? base.slice(0, 152) + '...' : base;
    } else {
      metaDesc = overview.length > 155 ? overview.slice(0, 152) + '...' : (overview || `Watch ${title} ${year ? '(' + year + ')' : ''} online free in HD on CineStream.`);
    }

    const pageTitle = `${title}${suffix}${year ? ' (' + year + ')' : ''} — CineStream`;
    const ogTitle = `${title}${suffix}${year ? ' (' + year + ')' : ''} | CineStream`;
    const keywords = [title, `${title} Hindi Dubbed`, `${title} in Hindi`, genres, `Watch ${title} online`, `${title} ${year}`, 'CineStream', 'free HD streaming'].filter(Boolean).join(', ');

    // ── Title & canonical ───────────────────────────────────────────────────
    document.title = pageTitle;
    this.setById('seo-title', 'textContent', pageTitle);
    this.setById('seo-desc', 'content', metaDesc);
    this.setById('seo-canonical', 'href', canonical);
    this.setMeta('keywords', keywords);

    // ── Open Graph ─────────────────────────────────────────────────────────
    this.setById('og-title', 'content', ogTitle);
    this.setById('og-desc', 'content', metaDesc);
    this.setById('og-url', 'content', canonical);
    this.setById('og-image', 'content', poster);
    // Add hi_IN locale alternate dynamically
    let ogLocaleAlt = document.querySelector('meta[property="og:locale:alternate"]');
    if (!ogLocaleAlt) {
      ogLocaleAlt = document.createElement('meta');
      ogLocaleAlt.setAttribute('property', 'og:locale:alternate');
      document.head.appendChild(ogLocaleAlt);
    }
    ogLocaleAlt.setAttribute('content', isToon ? 'hi_IN' : 'en_US');

    // ── Twitter Card ───────────────────────────────────────────────────────
    this.setById('tw-title', 'content', ogTitle);
    this.setById('tw-desc', 'content', metaDesc);
    this.setById('tw-image', 'content', poster);
    this.setById('tw-image-alt', 'content', `${title} poster`);

    // ── Modal breadcrumb ───────────────────────────────────────────────────
    const typeLabel = type === 'movie' ? 'Movies' : (this.getContentType(m, type) === 'Anime' ? 'Anime' : 'TV Series');
    const mbType = document.getElementById('modal-breadcrumb-type');
    const mbTitle = document.getElementById('modal-breadcrumb-title');
    if (mbType) mbType.textContent = typeLabel;
    if (mbTitle) mbTitle.textContent = title;

    // ── JSON-LD: Movie / TVSeries + BreadcrumbList ─────────────────────────
    const isMovie = type === 'movie';
    const schemaType = isMovie ? 'Movie' : 'TVSeries';
    const categoryPageUrl = `${SITE}/${isMovie ? '' : 'anime'}`;

    const schemaData = [
      {
        '@context': 'https://schema.org',
        '@type': schemaType,
        'name': title,
        'url': canonical,
        'image': {
          '@type': 'ImageObject',
          'url': poster,
          'width': 780,
          'height': 1170
        },
        'description': overview || metaDesc,
        'inLanguage': isToon ? ['hi', 'en'] : 'en',
        ...(isToon ? { 'countryOfOrigin': { '@type': 'Country', 'name': 'Japan' }, 'locationCreated': { '@type': 'Country', 'name': 'India' } } : {}),
        ...(m.release_date || m.first_air_date ? { 'datePublished': m.release_date || m.first_air_date } : {}),
        ...(genres ? { 'genre': genres.split(', ') } : {}),
        ...(m.vote_average && m.vote_count ? {
          'aggregateRating': {
            '@type': 'AggregateRating',
            'ratingValue': parseFloat(m.vote_average.toFixed(1)),
            'bestRating': 10,
            'worstRating': 1,
            'ratingCount': m.vote_count
          }
        } : {}),
        'potentialAction': {
          '@type': 'WatchAction',
          'target': watchUrl
        }
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': `${SITE}/` },
          { '@type': 'ListItem', 'position': 2, 'name': typeLabel, 'item': `${SITE}/` },
          { '@type': 'ListItem', 'position': 3, 'name': title, 'item': canonical }
        ]
      }
    ];

    const dynSlot = document.getElementById('ld-dynamic');
    if (dynSlot) {
      dynSlot.textContent = JSON.stringify(schemaData);
    } else {
      // Fallback: inject as new element
      let s = document.getElementById('moviebox-jsonld');
      if (!s) { s = document.createElement('script'); s.id = 'moviebox-jsonld'; s.type = 'application/ld+json'; document.head.appendChild(s); }
      s.textContent = JSON.stringify(schemaData);
    }
  },

  /** Fast ID-based setter for pre-existing meta/link/title elements */
  setById(id, attr, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (attr === 'textContent') el.textContent = value;
    else if (attr === 'href') el.setAttribute('href', value);
    else el.setAttribute(attr, value);
  },

  setMeta(name, content) {
    const el = document.querySelector(`meta[name="${name}"]`);
    if (el) el.setAttribute('content', content);
  },

  setMetaProperty(prop, content) {
    const el = document.querySelector(`meta[property="${prop}"]`);
    if (el) el.setAttribute('content', content);
  },

  setupNavScroll() {
    const nav = document.getElementById('navbar');
    if (!nav) return;
    window.addEventListener('scroll', () => {
      window.scrollY > 50 ? nav.classList.add('scrolled') : nav.classList.remove('scrolled');
    }, { passive: true });
  }
};

window.App = App;
App.init();
