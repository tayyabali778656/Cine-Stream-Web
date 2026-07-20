'use strict';

/**
 * services/cache.js — In-memory LRU cache with TTL
 *
 * A zero-dependency LRU cache backed by a Map (insertion-order maintained).
 * When capacity is exceeded the oldest entry is evicted (LRU semantics).
 *
 * Usage:
 *   const cache = require('./services/cache');
 *   cache.set('key', value, 60_000);   // TTL in milliseconds
 *   const v = cache.get('key');        // null if expired or not found
 *   cache.delete('key');
 *   cache.clear();
 *   cache.stats();                     // { size, hits, misses, evictions }
 */

const logger = require('../utils/logger');

const MAX_CAPACITY = 2000; // maximum number of cached entries

// ── Internal state ───────────────────────────────────────────────────────────
const store = new Map(); // key → { value, expiresAt }
let hits = 0;
let misses = 0;
let evictions = 0;

// ── LRU eviction helper ───────────────────────────────────────────────────────
function evictOldest() {
  const firstKey = store.keys().next().value;
  if (firstKey !== undefined) {
    store.delete(firstKey);
    evictions++;
  }
}

// ── Periodic cleanup: remove expired entries every 5 minutes ─────────────────
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of store) {
    if (entry.expiresAt && now > entry.expiresAt) {
      store.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    logger.debug('cache_cleanup', { removed, remaining: store.size });
  }
}, 5 * 60 * 1000).unref(); // .unref() so it doesn't keep the process alive

// ── Public API ────────────────────────────────────────────────────────────────
const cache = {
  /**
   * Store a value with an optional TTL (milliseconds).
   * Pass ttl=0 or omit to cache indefinitely.
   */
  set(key, value, ttlMs = 0) {
    // Evict oldest if at capacity
    if (store.size >= MAX_CAPACITY) {
      evictOldest();
    }
    // Re-inserting moves to the end (most-recently-used) in Map order
    store.delete(key);
    store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null,
    });
    logger.cache(false); // set is treated as a miss opportunity avoided
  },

  /**
   * Retrieve a value. Returns null if not found or expired.
   */
  get(key) {
    const entry = store.get(key);
    if (!entry) {
      misses++;
      logger.cache(false);
      return null;
    }
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      store.delete(key);
      misses++;
      logger.cache(false);
      return null;
    }
    // Move to end (most-recently-used)
    store.delete(key);
    store.set(key, entry);
    hits++;
    logger.cache(true);
    return entry.value;
  },

  /**
   * Delete a specific key.
   */
  delete(key) {
    store.delete(key);
  },

  /**
   * Delete all keys matching a prefix (useful for cache invalidation).
   */
  deleteByPrefix(prefix) {
    let count = 0;
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        store.delete(key);
        count++;
      }
    }
    return count;
  },

  /**
   * Clear entire cache.
   */
  clear() {
    store.clear();
  },

  /**
   * Cache statistics.
   */
  stats() {
    return {
      size: store.size,
      capacity: MAX_CAPACITY,
      hits,
      misses,
      evictions,
      hit_ratio: (hits + misses) > 0 ? (hits / (hits + misses)).toFixed(2) : 'N/A',
    };
  },

  /**
   * Check if a key exists and is not expired.
   */
  has(key) {
    return this.get(key) !== null;
  },
};

module.exports = cache;
