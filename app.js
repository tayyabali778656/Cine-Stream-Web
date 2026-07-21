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

  moviePool: [],
  tvPool: [],
  animePool: [],
  moviePage: 1,
  tvPage: 1,
  animePage: 1,
  renderedCount: 0,

  singleCategoryMode: 'anime', // 'movie', 'tv', 'anime'
  singleCategoryPage: 1,
  animeSubFilter: 'anime', // 'anime' only (cartoons removed)

  filterHidden(items) {
    if (!items || !Array.isArray(items)) return [];
    const cache = this.hiddenCache || new Set();
    return items.filter(item => !cache.has(String(item.id)));
  },

  // ── Initialize hiddenCache (prevents new Set() on every filterHidden call) ──
  _ensureHiddenCache() {
    if (!this.hiddenCache) this.hiddenCache = new Set();
  },

  async syncDatabaseCache(force = false) {
    // Throttle: only re-sync if cache is older than 30 seconds (unless forced)
    const now = Date.now();
    if (!force && this._lastDbSync && (now - this._lastDbSync) < 30_000) return;
    this._lastDbSync = now;

    try {
      const fetchJson = (url) => fetch(`${url}?_=${Date.now()}`, { cache: 'no-store', credentials: 'include' }).then(r => r.ok ? r.json() : []).catch(() => []);
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
  async init() {
    // Show skeletons instantly so the user sees a loading state immediately
    if (this.grid) {
      this.grid.innerHTML = '';
      this.showSkeletons();
    }

    const cachePromise = this.syncDatabaseCache();

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
    
    await cachePromise;
    await this.resetAndFetch();
    this.renderRecentlyViewed();
    this.setupNavScroll();
  },

  /**
   * Event Listeners setup
   */
  setupEventListeners() {
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

    // Anime vs Cartoon Sub-Filter Dropdown Selector
    const typeSelect = document.getElementById('media-type-filter-select');
    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        this.animeSubFilter = typeSelect.value;
        this.animePool = [];
        this.animePage = 1;
        this.renderedCount = 0;
        this.grid.innerHTML = '';
        this.renderedIds.clear();
        this.showSkeletons();
        this.fetchAndRenderBatch();
      });
    }

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

        if (this.singleCategoryMode) {
          // Reset the pool & page pointers for the active category
          const category = this.singleCategoryMode;
          if (category === 'movie') {
            this.moviePool = [];
            this.moviePage = 1;
          } else if (category === 'tv') {
            this.tvPool = [];
            this.tvPage = 1;
          } else if (category === 'anime') {
            this.animePool = [];
            this.animePage = 1;
          }
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

    // Load More button setup
    let loadMoreBtn = document.getElementById('load-more-btn');
    if (!loadMoreBtn) {
      let container = document.getElementById('load-more-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'load-more-container';
        container.style.textAlign = 'center';
        container.style.margin = '2rem 0';
        container.innerHTML = '<button id="load-more-btn" class="btn-primary">Load More</button>';
        this.grid.parentNode.insertBefore(container, this.grid.nextSibling);
      }
      loadMoreBtn = document.getElementById('load-more-btn');
    }

    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => {
        this.fetchAndRenderBatch();
      };
    }

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
  async resetAndFetch() {
    this.singleCategoryMode = 'anime';
    this.singleCategoryPage = 1;
    this.currentPage = 1;
    this.moviePage = 1;
    this.tvPage = 1;
    this.animePage = 1;
    this.moviePool = [];
    this.tvPool = [];
    this.animePool = [];
    this.renderedCount = 0;
    this.grid.innerHTML = '';
    this.renderedIds.clear();
    this.showSkeletons();

    // Hide back to feed button & heading
    const backToFeedBtn = document.getElementById('back-to-feed-btn');
    if (backToFeedBtn) backToFeedBtn.style.display = 'none';
    const heading = document.getElementById('category-view-heading');
    if (heading) heading.style.display = 'none';

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
      const labels = { movie: 'All Movies', tv: 'All TV Series', anime: 'All Anime' };
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

    await this.fetchAndRenderBatch();
  },

  /**
   * Fetch and render feed cards. Supports Homepage Combined Mode and Single Category Mode.
   */
  async fetchAndRenderBatch() {
    if (this._isLoadingFeed) return;
    this._isLoadingFeed = true;
    const isMobile = window.innerWidth <= 768;
    const blockSize = isMobile ? 6 : 10;
    const fMap = { 'trending': 'Trending', 'popular': 'Popular', 'top_rated': 'Top Rated', 'upcoming': 'Upcoming' };
    const filterTxt = fMap[this.currentFilter] || 'Trending';

    // 1. Single Category View Mode (30 cards per load, no sub-headings, bottom View More button)
    if (this.singleCategoryMode) {
      const type = this.singleCategoryMode;
      const targetSize = 30;

      const skeletons = [];
      for (let i = 0; i < 12; i++) {
        const card = document.createElement('div');
        card.className = 'movie-card skeleton';
        this.grid.appendChild(card);
        skeletons.push(card);
      }

      try {
        const pool = type === 'movie' ? this.moviePool : type === 'tv' ? this.tvPool : this.animePool;
        let pagePointer = type === 'movie' ? this.moviePage : type === 'tv' ? this.tvPage : this.animePage;

        let attempts = 0;
        while (pool.length < targetSize && attempts < 8) {
          attempts++;
          const requestType = (type === 'anime' && this.animeSubFilter === 'cartoon') ? 'cartoon' : type;
          const data = await API.getMovies(requestType, this.currentFilter, pagePointer, '', '');
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

            if (this.currentFilter === 'upcoming') {
              const nowUTC = new Date().toISOString().split('T')[0];
              results = results.filter(item => {
                const rd = item.release_date || item.first_air_date;
                return rd && rd > nowUTC;
              });
            }
            if (type === 'anime') {
              results = results.filter(item => {
                const isItemAnime = this.isAnime(item);
                return this.animeSubFilter === 'anime' ? isItemAnime : !isItemAnime;
              });
            }
            pool.push(...results);
            pagePointer++;
          } else {
            break;
          }
        }

        if (type === 'movie') { this.moviePage = pagePointer; }
        else if (type === 'tv') { this.tvPage = pagePointer; }
        else { this.animePage = pagePointer; }

        // Remove ALL skeleton cards (original 12 from showSkeletons + our 12 just appended)
        this.grid.querySelectorAll('.movie-card.skeleton').forEach(s => s.remove());

        const itemsToRender = pool.splice(0, targetSize);
        if (itemsToRender.length === 0) {
          // Only show Not Found if grid is truly empty (first load with no data)
          // If cards already exist (View More at end), just hide button gracefully
          if (this.grid.children.length === 0) {
            this.grid.innerHTML = `
              <div style="grid-column: 1 / -1; text-align: center; padding: 5rem 2rem; color: var(--text-muted); font-size: 1.5rem; font-weight: 600; background: var(--glass); border: 1px solid var(--glass-border); border-radius: 12px;">
                Not Found
              </div>
            `;
          }
          const loadMoreContainer = document.getElementById('load-more-container');
          if (loadMoreContainer) loadMoreContainer.style.display = 'none';
          return;
        }

        const cardsHtml = itemsToRender.map(m => {
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
          const typeVal = m.type || (m.title ? 'movie' : 'tv');
          const contentType = this.getContentType(m, typeVal);

          return `
            <div class="movie-card fade-in" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${typeVal}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle} (${year}) - ${contentType}">
              <span class="type-badge" aria-hidden="true">${contentType}</span>
              <img
                src="${poster}"
                alt="${safeTitle} poster"
                loading="lazy"
                decoding="async"
                width="500"
                height="750"
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

        // Auto-scan visible category items for 404 links in background
        this.scanFeedForBrokenVideos(itemsToRender);

        const loadMoreContainer = document.getElementById('load-more-container');
        if (loadMoreContainer) {
          loadMoreContainer.style.display = 'block';
          const btn = document.getElementById('load-more-btn');
          if (btn) btn.textContent = 'View More';
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

    // 2. Homepage Feed Combined Mode (1 block of Movies, 1 TV, 1 Anime with category buttons)
    const batchSize = blockSize * 3;
    this.grid.innerHTML = Array(batchSize).fill('<div class="movie-card skeleton"></div>').join('');

    try {
      const fetchPromises = [];

      if (this.moviePool.length < blockSize) {
        fetchPromises.push((async () => {
          let pagePointer = this.moviePage;
          while (this.moviePool.length < blockSize) {
            const data = await API.getMovies('movie', this.currentFilter, pagePointer, '', '');
            if (data && data.results && data.results.length > 0) {
              let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));
              if (this.currentFilter === 'upcoming') {
                const nowUTC = new Date().toISOString().split('T')[0];
                results = results.filter(item => {
                  const rd = item.release_date || item.first_air_date;
                  return rd && rd > nowUTC;
                });
              }
              this.moviePool.push(...results);
              pagePointer++;
            } else {
              break;
            }
          }
          this.moviePage = pagePointer;
        })());
      }

      if (this.tvPool.length < blockSize) {
        fetchPromises.push((async () => {
          let pagePointer = this.tvPage;
          while (this.tvPool.length < blockSize) {
            const data = await API.getMovies('tv', this.currentFilter, pagePointer, '', '');
            if (data && data.results && data.results.length > 0) {
              let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));
              if (this.currentFilter === 'upcoming') {
                const nowUTC = new Date().toISOString().split('T')[0];
                results = results.filter(item => {
                  const rd = item.release_date || item.first_air_date;
                  return rd && rd > nowUTC;
                });
              }
              this.tvPool.push(...results);
              pagePointer++;
            } else {
              break;
            }
          }
          this.tvPage = pagePointer;
        })());
      }

      if (this.animePool.length < blockSize) {
        fetchPromises.push((async () => {
          let pagePointer = this.animePage;
          let attempts = 0;
          while (this.animePool.length < blockSize && attempts < 8) {
            attempts++;
            const data = await API.getMovies('anime', this.currentFilter, pagePointer, '', '');
            if (data && data.results && data.results.length > 0) {
              let results = this.filterHidden(data.results.filter(item => item.poster || item.poster_path));

              if (this.currentFilter === 'upcoming') {
                const nowUTC = new Date().toISOString().split('T')[0];
                results = results.filter(item => {
                  const rd = item.release_date || item.first_air_date;
                  return rd && rd > nowUTC;
                });
              }
              results = results.filter(item => this.isAnime(item));
              this.animePool.push(...results);
              pagePointer++;
            } else {
              break;
            }
          }
          this.animePage = pagePointer;
        })());
      }

      await Promise.all(fetchPromises);

      const moviesToRender = this.moviePool.splice(0, blockSize);
      const tvToRender = this.tvPool.splice(0, blockSize);
      const animeToRender = this.animePool.splice(0, blockSize);

      // Render category groups regardless of empty states so Not Found placeholders show correctly

      const renderGroup = (items, label, fallbackType, targetCategory) => {
        const headingHtml = `
          <h3 class="section-title" style="grid-column: 1 / -1; margin-top: 2rem; margin-bottom: 0.5rem; width: 100%; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">
            ${filterTxt} ${label}
          </h3>
        `;

        if (items.length === 0) {
          return headingHtml + `
            <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 2rem; color: var(--text-muted); font-size: 1.2rem; font-weight: 500; background: var(--glass); border: 1px solid var(--glass-border); border-radius: 12px; margin-bottom: 1.5rem;">
              Not Found
            </div>
          `;
        }

        const cardsHtml = items.map(m => {
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
          const posterSm = poster;
          const posterMd = poster;
          const type = isManual ? (m.type || fallbackType) : (m.title ? 'movie' : 'tv');

          const contentType = this.getContentType(m, type);

          return `
            <div class="movie-card fade-in" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${type}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle}">
              <span class="type-badge" aria-hidden="true">${contentType}</span>
              <img
                src="${poster}"
                srcset="${posterSm} 200w, ${posterMd} 342w, ${poster} 500w"
                sizes="(max-width:480px) 160px, (max-width:768px) 200px, 240px"
                alt="${safeTitle} poster"
                loading="lazy"
                decoding="async"
                width="500"
                height="750"
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

        const buttonHtml = `
          <button class="btn-secondary" style="grid-column: 1 / -1; margin: 1.5rem auto; display: block;" onclick="App.switchToCategory('${targetCategory}')">
            View More ${label}
          </button>
        `;

        return headingHtml + cardsHtml + buttonHtml;
      };

      this.grid.innerHTML = '';
      this.renderedIds.clear();

      const batchContainer = document.createElement('div');
      batchContainer.style.display = 'contents';
      batchContainer.innerHTML =
        renderGroup(moviesToRender, 'Movies', 'movie', 'movie') +
        renderGroup(tvToRender, 'TV Series', 'tv', 'tv') +
        renderGroup(animeToRender, 'Anime', 'tv', 'anime');
      this.grid.appendChild(batchContainer);

      // Auto-scan visible homepage items for 404 links in background
      this.scanFeedForBrokenVideos(moviesToRender);
      this.scanFeedForBrokenVideos(tvToRender);
      this.scanFeedForBrokenVideos(animeToRender);

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
    this.grid.innerHTML = Array(12).fill('<div class="movie-card skeleton"></div>').join('');
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
        const posterSm = poster;
        const posterMd = poster;

        const contentType = this.getContentType(m, m.type);

        return `
          <div class="movie-card fade-in" tabindex="0" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${m.type}', true, false, ${m.netmirror ? 'true' : 'false'})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" aria-label="${safeTitle}">
            <span class="type-badge" aria-hidden="true">${contentType}</span>
            <img
              src="${poster}"
              srcset="${posterSm} 200w, ${posterMd} 342w, ${poster} 500w"
              sizes="(max-width:480px) 160px, (max-width:768px) 200px, 240px"
              alt="${safeTitle} poster"
              loading="lazy"
              decoding="async"
              width="500"
              height="750"
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

    } catch (e) {
      console.error(e);
      if (resultsGrid) resultsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 5rem; color: #666; font-size:1.5rem;">Search failed.</div>';
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

      // Sync admin cache in background (non-blocking, fire-and-forget)
      this.syncDatabaseCache(true).catch(() => { });

      const adminStore = this.adminCache || {};
      if (adminStore[movieId] || adminStore[String(movieId)]) {
        movie = adminStore[movieId] || adminStore[String(movieId)];
      } else {
        // ── Fetch anime details from database ────────────────────────────────
        const detailsRes = await fetch(`/api/v1/anime/details?id=${encodeURIComponent(movieId)}`).then(r => r.json());
        if (detailsRes && detailsRes.id) {
          // Map ToonStream fields to the shape the rest of the modal code expects
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
        } else {
          throw new Error('Anime not found in database. Please run the crawler first.');
        }
      }


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
      document.getElementById('modal-title').textContent = movie.title || movie.name;

      const ratingVal = movie.vote_average || movie.rating || 7.5;
      const ratingHtml = `<i class="fas fa-star rating-star"></i> ${parseFloat(ratingVal).toFixed(1)}`;
      const yearHtml = `<i class="far fa-calendar-alt"></i> ${(movie.release_date || movie.first_air_date || '????').split('-')[0]}`;

      document.getElementById('modal-rating').innerHTML = ratingHtml;
      document.getElementById('modal-year').innerHTML = yearHtml;

      const mobRating = document.getElementById('modal-rating-mobile');
      const mobYear = document.getElementById('modal-year-mobile');
      if (mobRating) mobRating.innerHTML = ratingHtml;
      if (mobYear) mobYear.innerHTML = yearHtml;

      document.getElementById('modal-description').textContent = movie.overview || movie.description || 'No description available.';

      this.updateMetaTags(movie, type);

      const genresEl = document.getElementById('modal-genres');
      if (genresEl) {
        let genreNames = '';
        if (movie.genres) {
          genreNames = movie.genres.map(g => (typeof g === 'string' ? g : g.name)).join(', ');
        } else if (movie.genres_str) {
          genreNames = movie.genres_str;
        }
        genresEl.textContent = genreNames || '';
        genresEl.style.display = genreNames ? '' : 'none';
      }

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
          this.openModal(movieId, type, true, false, isNetMirror);
        };
      }

      const trailerContainer = document.getElementById('trailer-container');
      const noTrailer = document.getElementById('no-trailer');
      const heroOverlay = document.querySelector('.modal-hero-overlay');

      if (trailerContainer) {
        trailerContainer.innerHTML = '';
      }
      if (noTrailer) noTrailer.style.display = 'none';

      if (isWatching) {
        this.modal.classList.add('watching');
        this.addToRecentlyViewed(movie, type);
        this.renderRecentlyViewed();
        if (soundToggle) soundToggle.style.display = 'none';
        if (backBtn) backBtn.style.display = 'flex';
        if (heroOverlay) heroOverlay.style.display = 'none';

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
            if (isWatching) {
              const url = new URL(window.location.href);
              url.searchParams.set('s', s);
              url.searchParams.set('e', e);
              window.history.replaceState(window.history.state, '', url.pathname + url.search);
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
            const downloadUrl = '#';
            dlContainer.innerHTML = `
              <a href="${downloadUrl}" target="_blank" class="btn-primary" style="padding: 6px 12px; font-size: 0.85rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; font-weight: 600; box-shadow: 0 4px 12px rgba(229, 9, 20, 0.4); border: none; cursor: pointer; color: white;">
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
            noTrailer.textContent = 'STREAM NOT AVAILABLE';
            noTrailer.style.display = 'flex';
          }
        }
      } else {
        if (backBtn) backBtn.style.display = 'none';
        if (heroOverlay) heroOverlay.style.display = 'block';

        const trailerUrl = await API.getTrailer(movieId, type);

        if (trailerContainer && noTrailer) {
          if (trailerUrl) {
            if (soundToggle) soundToggle.style.display = 'flex';
            trailerContainer.innerHTML = `<iframe id="trailer-video" src="${trailerUrl}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
            noTrailer.style.display = 'none';
          } else {
            trailerContainer.innerHTML = '';
            noTrailer.textContent = 'TRAILER NOT AVAILABLE';
            noTrailer.style.display = 'flex';
            if (soundToggle) soundToggle.style.display = 'none';
          }
        }
      }

      const body = document.querySelector('.modal-body');
      const hero = document.querySelector('.modal-hero');
      const controlBar = document.getElementById('player-control-bar');
      if (body && hero) {
        if (isWatching) {
          body.style.display = 'none';
          hero.style.height = 'calc(100% - 50px)';
          hero.style.display = 'block'; // Bypass mobile hide rule
          if (controlBar) controlBar.style.display = 'flex';
        } else {
          body.style.display = 'flex';
          hero.style.height = ''; // Revert to stylesheet height rule
          hero.style.display = ''; // Revert to stylesheet display rule
          if (controlBar) controlBar.style.display = 'none';
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
    if (noTrailer) noTrailer.style.display = 'none';
    if (backBtn) backBtn.style.display = 'none';
    const controlBar = document.getElementById('player-control-bar');
    if (controlBar) controlBar.style.display = 'none';
    if (heroOverlay) heroOverlay.style.display = 'block';

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
        const altText = `${title} ${cardType === 'movie' ? 'Movie' : 'TV Series'} poster`;
        return `
          <div class="movie-card" role="listitem" style="aspect-ratio: 2/3; flex: 0 0 auto; width: 150px; scroll-snap-align: start;" onclick="App.openModal('${String(m.id).replace(/'/g, "\\'")}', '${cardType}')" tabindex="0" onkeydown="if(event.key==='Enter'){this.click();}" aria-label="Continue watching ${title}">
             <img src="${poster}" alt="${altText}" loading="eager" fetchpriority="${idx < 6 ? 'high' : 'auto'}" decoding="sync" width="150" height="225">
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
    if (this.currentFilter === 'upcoming') return;
    if (!items || !Array.isArray(items)) return;

    // Scan missing download source catalog links
    this.checkMissingCatalog(items);
  },

  /**
   * Dynamic SEO System
   * Updates meta, canonical, OG, Twitter, JSON-LD, and modal breadcrumb
   * on every modal open. Domain: cinestream.watch
   */
  updateMetaTags(m, type) {
    const SITE = 'https://cinestream.watch';
    const IMG_BASE = 'https://image.tmdb.org/t/p/w780';
    const title = m.title || m.name || 'CineStream';
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
