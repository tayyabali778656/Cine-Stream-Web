'use strict';

/**
 * services/sitemapService.js — Auto Sitemap Scheduler
 *
 * Responsibilities:
 *  - Generate sitemap on first server startup (if sitemap.xml is missing or stale)
 *  - Auto-regenerate every 24 hours via scheduled interval
 *  - Expose triggerRegen() for instant regeneration when new content is added
 *  - Debounce rapid consecutive triggers (e.g., bulk imports) with 30s delay
 *
 * This is the ONLY way the sitemap is regenerated in production.
 * Never call generateSitemap.js directly from routes — use triggerRegen() instead.
 */

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const logger       = require('../utils/logger');

const ROOT_DIR       = path.join(__dirname, '..');
const SCRIPT_PATH    = path.join(ROOT_DIR, 'scripts', 'generateSitemap.js');
const SITEMAP_PATH   = path.join(ROOT_DIR, 'sitemap.xml');

// How often to auto-regenerate (24 hours)
const REGEN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Debounce: wait 30s after last trigger before actually running
// (avoids multiple rapid rebuilds during bulk content imports)
const DEBOUNCE_MS = 30_000;

let _debounceTimer   = null;
let _isRunning       = false;
let _pendingAfter    = false;  // if a trigger came in while running, queue another run

// ─── Core: Run the generator script ──────────────────────────────────────────

function runGenerator(reason) {
  if (process.env.VERCEL) {
    logger.info('sitemap_regen_skipped', { reason: 'running_on_vercel', trigger: reason });
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    if (_isRunning) {
      logger.info('sitemap_regen_skipped', { reason: 'already_running', trigger: reason });
      _pendingAfter = true;
      return resolve(false);
    }

    _isRunning = true;
    logger.info('sitemap_regen_start', { trigger: reason });
    const start = Date.now();

    execFile(process.execPath, [SCRIPT_PATH], { cwd: ROOT_DIR }, (err, stdout, stderr) => {
      _isRunning = false;
      const elapsed = Date.now() - start;

      if (err) {
        logger.error('sitemap_regen_failed', { trigger: reason, error: err.message, elapsed });
      } else {
        // Log last line of output (summary line)
        const lines = stdout.trim().split('\n');
        const summary = lines.filter(l => l.includes('Total') || l.includes('✅') || l.includes('Wrote')).join(' | ');
        logger.info('sitemap_regen_done', { trigger: reason, summary, elapsed });
      }

      if (stderr && stderr.trim()) {
        logger.warn('sitemap_regen_stderr', { stderr: stderr.slice(0, 500) });
      }

      // If something queued during our run, do it now
      if (_pendingAfter) {
        _pendingAfter = false;
        setTimeout(() => runGenerator('queued_after_run'), 5000);
      }

      resolve(!err);
    });
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * triggerRegen(reason)
 *
 * Call this whenever new content is added, updated, or deleted.
 * Debounced: rapid calls within 30s are collapsed into one rebuild.
 *
 * Example usage in serve.js:
 *   sitemapSvc.triggerRegen('new_movie_added');
 */
function triggerRegen(reason = 'manual') {
  if (process.env.VERCEL) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  logger.info('sitemap_regen_queued', { trigger: reason, debounce_ms: DEBOUNCE_MS });
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    runGenerator(reason);
  }, DEBOUNCE_MS);
}

/**
 * scheduleAutoRegen()
 *
 * Call once at server startup.
 *  - If sitemap.xml is missing or older than 24h → run immediately
 *  - Schedule periodic rebuild every 24h
 */
function scheduleAutoRegen() {
  if (process.env.VERCEL) {
    logger.info('sitemap_scheduler_skipped', { reason: 'running_on_vercel' });
    return;
  }
  let needsImmediateRun = false;

  if (!fs.existsSync(SITEMAP_PATH)) {
    logger.info('sitemap_missing', { action: 'will_generate_now' });
    needsImmediateRun = true;
  } else {
    const ageMs = Date.now() - fs.statSync(SITEMAP_PATH).mtimeMs;
    const ageHours = Math.round(ageMs / 3_600_000);
    if (ageMs > REGEN_INTERVAL_MS) {
      logger.info('sitemap_stale', { age_hours: ageHours, action: 'will_regenerate_now' });
      needsImmediateRun = true;
    } else {
      logger.info('sitemap_fresh', { age_hours: ageHours, next_regen_in_hours: Math.round((REGEN_INTERVAL_MS - ageMs) / 3_600_000) });
    }
  }

  // Run immediately if needed (small delay to let server fully start first)
  if (needsImmediateRun) {
    setTimeout(() => runGenerator('startup_missing_or_stale'), 5000);
  }

  // Periodic auto-rebuild every 24 hours
  const interval = setInterval(() => {
    runGenerator('scheduled_24h');
  }, REGEN_INTERVAL_MS);
  interval.unref(); // don't keep process alive just for this

  logger.info('sitemap_scheduler_started', {
    auto_regen_every: '24h',
    immediate: needsImmediateRun,
  });
}

module.exports = { scheduleAutoRegen, triggerRegen };
