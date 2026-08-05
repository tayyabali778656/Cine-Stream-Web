/**
 * CineStream Service Worker
 * 
 * Properly handles fetch events so that API requests and PWA resources
 * are NEVER intercepted or blocked.
 */

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

  // For all other requests, fall through to browser default (no interception).
});
