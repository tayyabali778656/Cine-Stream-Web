/**
 * CineStream Service Worker
 * 
 * Properly handles fetch events so that API requests and PWA resources
 * are NEVER intercepted or blocked. Third-party ad script is loaded
 * ONLY after we pass through all critical site requests.
 */

// ── Ad network config ─────────────────────────────────────────────────────────
self.options = {
  "domain": "5gvci.com",
  "zoneId": 11462725
};
self.lary = "";

// ── Critical paths that must NEVER be intercepted ─────────────────────────────
const PASSTHROUGH_PREFIXES = [
  '/api/',
  '/proxy',
  '/iframe-proxy',
  '/health',
];

const PASSTHROUGH_EXACT = [
  '/site.webmanifest',
  '/manifest.json',
  '/sw.js',
  '/service-worker.js',
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap-index.xml',
];

// ── Intercept all fetch requests ──────────────────────────────────────────────
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  // Always pass through same-origin API and critical PWA resources directly
  // without involving the ad network's fetch handler
  if (url.origin === self.location.origin) {
    const pathname = url.pathname;

    // Pass through API, proxy, and critical static assets
    const isPassthrough =
      PASSTHROUGH_PREFIXES.some(p => pathname.startsWith(p)) ||
      PASSTHROUGH_EXACT.includes(pathname);

    if (isPassthrough) {
      // Fetch directly from network — do NOT let ad script intercept
      event.respondWith(fetch(event.request));
      return;
    }
  }

  // For all other requests, fall through to browser default (no interception)
  // The ad script is loaded below but does not get a chance to intercept
  // same-origin API calls because we already handled them above.
});

// ── Load the ad network service worker script ─────────────────────────────────
// This runs AFTER our fetch listener is registered, so our listener
// takes priority over any fetch listeners registered by the ad script.
// importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw');
