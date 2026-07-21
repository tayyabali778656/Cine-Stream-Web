/**
 * StreamPlayer.js — Production-grade streaming manager
 *
 * Handles automatic source failover, health checking, retry logic,
 * and stream analytics for the MovieBox video player.
 *
 * Architecture:
 *  Primary Source → Health Check → Fallback 1 → Fallback 2 → Error Recovery
 *
 * Usage:
 *  const player = new StreamPlayer(containerElement, { sources, onError, onSwitch });
 *  player.load();
 */

'use strict';

class StreamPlayer {
  /**
   * @param {HTMLElement} container - The element to inject the player into
   * @param {Object} options
   * @param {Array<{url:string, type:'iframe'|'hls'|'mp4', label:string}>} options.sources
   * @param {string}  options.movieId
   * @param {string}  options.title
   * @param {Function} options.onError   - Called when all sources fail
   * @param {Function} options.onSwitch  - Called when switching source (index, label)
   * @param {Function} options.onReady   - Called when a source loads successfully
   */
  constructor(container, options = {}) {
    this.container = container;
    this.sources = options.sources || [];
    this.movieId = options.movieId || '';
    this.title = options.title || '';
    this.onError = options.onError || (() => { });
    this.onSwitch = options.onSwitch || (() => { });
    this.onReady = options.onReady || (() => { });
    this.onRefreshSource = options.onRefreshSource || null;
    this.currentSeason = 1;
    this.currentEpisode = 1;
    this._isRefreshing = false;

    this.currentIndex = 0;
    this.retryCount = 0;
    this.MAX_RETRIES = 3;
    this.TIMEOUT_MS = 8000;  // Consider source dead after 8s
    this.isDestroyed = false;

    this._timeoutHandle = null;
    this._analyticsData = { startTime: null, switches: 0, errors: 0 };
  }

  // ── Load the first available source ────────────────────────────────────────
  async load() {
    if (this.sources.length === 0) {
      this._showError('No streaming sources configured.');
      return;
    }
    this._analyticsData.startTime = Date.now();
    this.tryCount = 0;

    await this.updateSources(this.sources);
  }

  // ── Try a specific source by index ─────────────────────────────────────────
  async _trySource(index) {
    if (this.isDestroyed) return;

    if (index < 0 || index >= this.sources.length) {
      this._onAllFailed();
      return;
    }

    this.currentIndex = index;
    const source = this.sources[index];
    this.tryCount++;

    this._showLoading(source.label || `Source ${index + 1}`);
    this._log('stream_try', { index, label: source.label, url: source.url });

    // Perform automatic health check
    const isHealthy = await this._healthCheck(source.url);
    if (!isHealthy) {
      this._log('stream_unhealthy', { label: source.label, url: source.url });
      this._analyticsData.errors++;
      this._reportBroken(source.url);
      this._trySource(index + 1);
      return;
    }

    this._loadSource(source);
  }

  // ── Health check via proxy HEAD request ────────────────────────────────────
  async _healthCheck(url) {
    if (!url) return false;
    if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('netmirror.global')) return true;

    // For local iframe-proxy URLs, check if they are healthy by fetching them and checking for "Server Unavailable"
    if (url.startsWith('/iframe-proxy')) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000), // Resolution can take a few seconds
        });
        const text = await res.text();
        if (text.includes('Server Unavailable') || text.includes('deleted from the host')) {
          return false;
        }
        return true;
      } catch (e) {
        // Network/timeout error (often caused by ad-blockers) - assume healthy and let the iframe try loading.
        // This prevents false broken video reports.
        return true;
      }
    }

    if (url.startsWith('/')) return true;

    try {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      // Consider 404 as unhealthy
      if (json.statusCode === 404) return false;
      if (json.content && (
        json.content.toLowerCase().includes('404 not found') ||
        json.content.toLowerCase().includes('page not found') ||
        json.content.toLowerCase().includes('video not found')
      )) return false;
      return true;
    } catch {
      // Network error — try loading anyway (proxy might be unavailable)
      return true;
    }
  }

  // ── Inject the player iframe/video into the container ─────────────────────
  _loadSource(source) {
    if (this.isDestroyed) return;
    this._clearTimeout();
    this.container.innerHTML = '';

    this._log('stream_load', { label: source.label, type: source.type });

    if (source.type === 'mp4' || source.type === 'hls') {
      this._loadVideoElement(source);
    } else {
      this._loadIframe(source);
    }

    this.onReady(this.currentIndex, source.label);
  }

  _loadIframe(source) {
    const iframe = document.createElement('iframe');
    iframe.id = 'main-player';
    
    let playUrl = source.url;
    if (playUrl && !playUrl.startsWith('/') && !playUrl.startsWith('http://localhost') && !playUrl.includes('youtube.com') && !playUrl.includes('youtu.be') && !playUrl.includes('netmirror.global')) {
      playUrl = `/iframe-proxy?url=${encodeURIComponent(playUrl)}`;
    }
    iframe.src = playUrl;

    // Load admin allowed-ads settings from localStorage (synced on load from MongoDB)
    const requiresAdsList = (() => {
      try { return JSON.parse(localStorage.getItem('moviebox_requires_ads_servers')) || []; }
      catch (e) { return []; }
    })();
    const allowAds = requiresAdsList.some(lbl => source.label && source.label.includes(lbl));

    if (!allowAds) {
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
    }
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    iframe.setAttribute('loading', 'lazy');

    // Clear timeout once iframe fires load (doesn't guarantee stream plays)
    iframe.onload = () => {
      this._clearTimeout();
      this._log('stream_iframe_loaded', { label: source.label });
      StreamPlayer._trackAnalytics('stream_start', { movieId: this.movieId, source: source.label });
    };

    iframe.onerror = () => {
      this._clearTimeout();
      this._analyticsData.errors++;
      this._reportBroken(source.url);
    };

    this.container.appendChild(iframe);
  }

  // ── Native video element (MP4 / HLS) ──────────────────────────────────────
  _loadVideoElement(source) {
    const video = document.createElement('video');
    video.id = 'main-player';
    video.controls = true;
    video.autoplay = true;
    video.style.cssText = 'width:100%;height:100%;background:#000;';
    video.setAttribute('playsinline', '');
    if (window.location.hostname.includes('localhost') || window.location.hostname.includes('127.0.0.1')) {
      video.setAttribute('referrerpolicy', 'no-referrer');
    }

    if (source.type === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ maxMaxBufferLength: 30, enableWorker: true });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, async (event, data) => {
        if (data.fatal) {
          this._clearTimeout();
          this._analyticsData.errors++;

          if (this.onRefreshSource && !this._isRefreshing) {
            this._isRefreshing = true;
            const savedTime = video.currentTime;
            try {
              const freshUrl = await this.onRefreshSource(source, this);
              if (freshUrl) {
                console.log("[StreamPlayer] HLS expired URL refreshed successfully.");
                source.url = freshUrl;
                hls.loadSource(freshUrl);
                video.onloadedmetadata = () => {
                  video.currentTime = savedTime;
                  video.play().catch(e => console.error("[StreamPlayer] Resume play failed:", e));
                  this._isRefreshing = false;
                };
                return;
              }
            } catch (e) {
              console.error("[StreamPlayer] HLS refresh error:", e);
            }
            this._isRefreshing = false;
          }
          this._trySource(this.currentIndex + 1);
        }
      });
    } else if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = source.url;
    } else {
      video.src = source.url;
    }

    video.onloadeddata = () => {
      this._clearTimeout();
      StreamPlayer._trackAnalytics('stream_start', { movieId: this.movieId, source: source.label });
    };

    video.onerror = async () => {
      this._clearTimeout();
      this._analyticsData.errors++;

      if (this.onRefreshSource && !this._isRefreshing) {
        this._isRefreshing = true;
        const savedTime = video.currentTime;
        console.log("[StreamPlayer] Video load error, attempting source refresh at time:", savedTime);
        try {
          const freshUrl = await this.onRefreshSource(source, this);
          if (freshUrl) {
            console.log("[StreamPlayer] Direct CDN URL refreshed successfully. Resuming playback...");
            source.url = freshUrl;
            video.src = freshUrl;
            video.load();
            video.onloadedmetadata = () => {
              video.currentTime = savedTime;
              video.play().catch(e => console.error("[StreamPlayer] Resume play failed:", e));
              this._isRefreshing = false;
            };
            return;
          }
        } catch (e) {
          console.error("[StreamPlayer] Direct CDN URL refresh error:", e);
        }
        this._isRefreshing = false;
      }

      this._trySource(this.currentIndex + 1);
    };

    this.container.appendChild(video);
  }

  // ── All sources exhausted ──────────────────────────────────────────────────
  _onAllFailed() {
    this._log('stream_all_failed', { movieId: this.movieId, switches: this._analyticsData.switches });
    StreamPlayer._trackAnalytics('stream_error', { movieId: this.movieId, title: this.title });
    this._showError('No working stream found. This content may be unavailable.');
    this.onError();
  }

  // ── Report a broken/failed URL to the backend (via queue) ─────────────────
  _reportBroken(url) {
    if (!this.movieId) return;
    const season = this.currentSeason || 1;
    const episode = this.currentEpisode || 1;
    const isTV = (season && episode) || this.sources.some(s => s.url && (s.url.includes('/tv/') || s.url.includes('/episode/')));

    const id = String(this.movieId) + (isTV ? `_S${season}E${episode}` : '');
    const displayTitle = this.title + (isTV ? ` - Season ${season} Episode ${episode}` : '');

    fetch('/api/v1/broken-videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        id: id,
        mediaId: String(this.movieId),
        title: displayTitle,
        brokenUrl: url,
        reportedAt: new Date().toISOString(),
        season: isTV ? season : null,
        episode: isTV ? episode : null,
        type: isTV ? 'tv' : 'movie'
      }),
    }).catch(() => { }); // Fire and forget
  }

  // ── Manual source switch (from server selector UI) ────────────────────────
  async switchTo(index) {
    if (index < 0 || index >= this.sources.length) return;
    this._clearTimeout();
    this.tryCount = 0;
    this._analyticsData.switches++;
    StreamPlayer._trackAnalytics('stream_switch', {
      movieId: this.movieId,
      from: this.currentIndex,
      to: index,
    });
    this.onSwitch(index, this.sources[index]?.label || `Source ${index + 1}`);
    await this._trySource(index);
  }

  // ── Update sources and reload (e.g., season/episode change) ──────────────
  async updateSources(newSources) {
    // Load admin allowed-ads settings from localStorage (synced on load from MongoDB)
    const requiresAdsList = (() => {
      try { return JSON.parse(localStorage.getItem('moviebox_requires_ads_servers')) || []; }
      catch (e) { return []; }
    })();

    // Deduplicate incoming sources by URL and formatted label to avoid duplicate servers
    const seenUrls = new Set();
    const seenLabels = new Set();
    const uniqueSources = [];

    for (const source of newSources) {
      if (!source.url || seenUrls.has(source.url)) continue;

      let cleanLabel = source.label.replace(/\s*\(Ads\)/gi, '').replace(/\s*\(No Ads\)/gi, '').trim();
      const requiresAds = requiresAdsList.includes(cleanLabel);
      const formattedLabel = requiresAds ? `${cleanLabel} (Ads)` : `${cleanLabel} (No Ads)`;

      if (seenLabels.has(formattedLabel)) continue;

      seenUrls.add(source.url);
      seenLabels.add(formattedLabel);

      uniqueSources.push({
        ...source,
        label: formattedLabel
      });
    }

    this.sources = uniqueSources;

    this.retryCount = 0;
    this.tryCount = 0;

    if (this.sources.length === 0) {
      this._showError('No streaming sources found.');
      return;
    }

    this.currentIndex = 0;

    // Update the server select dropdown options in parent container
    const serverSelect = document.getElementById('player-server-select');
    if (serverSelect) {
      serverSelect.innerHTML = this.sources.map((src, idx) => {
        return `<option value="${idx}">${src.label}</option>`;
      }).join('');
      serverSelect.style.display = this.sources.length > 1 ? 'inline-block' : 'none';
      serverSelect.value = 0;
    }

    await this._trySource(0);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  _showLoading(label = 'Loading...') {
    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;color:#fff;background:#0f0f0f;gap:14px;font-family:'Outfit',sans-serif;">
        <i class="fas fa-spinner fa-spin" style="font-size:2.5rem;color:var(--primary,#e50914);"></i>
        <span style="font-size:0.95rem;font-weight:600;opacity:0.85;">Loading ${label}…</span>
      </div>`;
  }

  _showError(message) {
    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                  height:100%;color:#ffaa00;background:#0f0f0f;gap:14px;font-family:'Outfit',sans-serif;
                  text-align:center;padding:2rem;">
        <i class="fas fa-exclamation-circle" style="font-size:3rem;"></i>
        <span style="font-size:1rem;font-weight:600;max-width:400px;">${message}</span>
        <button onclick="this.closest('div').parentNode._streamPlayer?.load()"
                style="margin-top:8px;padding:10px 24px;background:var(--primary,#e50914);border:none;
                       border-radius:8px;color:#fff;font-family:'Outfit',sans-serif;font-weight:700;
                       cursor:pointer;font-size:0.9rem;">
          <i class="fas fa-redo"></i> Retry
        </button>
      </div>`;
    // Attach reference for retry button
    this.container._streamPlayer = this;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  destroy() {
    this.isDestroyed = true;
    this._clearTimeout();
    const endTime = Date.now();
    if (this._analyticsData.startTime) {
      StreamPlayer._trackAnalytics('stream_end', {
        movieId: this.movieId,
        duration_s: Math.round((endTime - this._analyticsData.startTime) / 1000),
        switches: this._analyticsData.switches,
        errors: this._analyticsData.errors,
      });
    }
    this.container.innerHTML = '';
  }

  _clearTimeout() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  _log(event, data = {}) {
    if (typeof console !== 'undefined') {
      console.log(`[StreamPlayer] ${event}`, data);
    }
  }

  // ── Static: analytics tracker ──────────────────────────────────────────────
  static _trackAnalytics(event, data = {}) {
    // Future: POST to /api/v1/analytics endpoint
    // For now, log to console and localStorage for admin review
    const entry = { event, ...data, timestamp: new Date().toISOString() };
    try {
      const log = JSON.parse(localStorage.getItem('mb_stream_analytics') || '[]');
      log.unshift(entry);
      if (log.length > 50) log.splice(50); // keep last 50 events
      localStorage.setItem('mb_stream_analytics', JSON.stringify(log));
    } catch { /* Storage full — ignore */ }
    console.log('[StreamAnalytics]', event, data);
  }
}

// Expose globally for use in app.js
window.StreamPlayer = StreamPlayer;
