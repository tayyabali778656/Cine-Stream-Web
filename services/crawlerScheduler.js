'use strict';

/**
 * services/crawlerScheduler.js - Auto Crawler Scheduler
 *
 * - Runs ToonStream crawler on startup if last run was more than 24h ago
 * - Repeats every 24 hours automatically
 * - After each crawl: triggers sitemap rebuild
 * - Safe from parallel runs
 * - Skipped on Vercel (serverless)
 */

const { execFile } = require('child_process');
const path         = require('path');
const fsModule     = require('fs');
const logger       = require('../utils/logger');

const ROOT_DIR       = path.join(__dirname, '..');
const CRAWLER_SCRIPT = path.join(ROOT_DIR, 'scripts', 'updateCatalogs.js');
const LOCK_FILE      = path.join(ROOT_DIR, '.crawler_last_run');

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let _isRunning      = false;
let _intervalHandle = null;

// Run crawler in child process
function runCrawler(reason) {
  if (process.env.VERCEL) {
    logger.info('crawler_scheduler_skipped', { reason: 'running_on_vercel' });
    return Promise.resolve(false);
  }
  if (_isRunning) {
    logger.info('crawler_scheduler_skipped', { reason: 'already_running', trigger: reason });
    return Promise.resolve(false);
  }

  _isRunning = true;
  const start = Date.now();
  logger.info('crawler_scheduler_started', { trigger: reason });

  return new Promise((resolve) => {
    execFile(process.execPath, [CRAWLER_SCRIPT], {
      cwd: ROOT_DIR,
      timeout: 10 * 60 * 1000   // 10 min max
    }, (err, stdout, stderr) => {
      _isRunning = false;
      const elapsed = Math.round((Date.now() - start) / 1000);

      if (err) {
        logger.error('crawler_scheduler_failed', {
          trigger: reason,
          error: err.message,
          elapsed_s: elapsed
        });
        resolve(false);
      } else {
        // Save successful run timestamp
        try { fsModule.writeFileSync(LOCK_FILE, String(Date.now()), 'utf8'); } catch (_) {}

        logger.info('crawler_scheduler_done', { trigger: reason, elapsed_s: elapsed });

        // Trigger sitemap rebuild after crawl finishes
        try {
          const sitemapSvc = require('./sitemapService');
          sitemapSvc.triggerRegen('post_crawler_run');
          logger.info('crawler_scheduler_sitemap_triggered');
        } catch (e) {
          logger.warn('crawler_scheduler_sitemap_trigger_failed', { error: e.message });
        }

        resolve(true);
      }

      if (stderr && stderr.trim()) {
        logger.warn('crawler_scheduler_stderr', { stderr: stderr.slice(0, 300) });
      }
    });
  });
}

// Check if last run was more than 24h ago
function isStale() {
  try {
    const raw     = fsModule.readFileSync(LOCK_FILE, 'utf8');
    const lastRun = parseInt(raw, 10);
    if (isNaN(lastRun)) return true;
    const ageMs = Date.now() - lastRun;
    logger.info('crawler_last_run_info', {
      age_hours:     Math.round(ageMs / 3_600_000),
      next_in_hours: Math.max(0, Math.round((INTERVAL_MS - ageMs) / 3_600_000))
    });
    return ageMs > INTERVAL_MS;
  } catch (_) {
    return true; // No lock file = never run
  }
}

// Call once at server startup
function scheduleAutoCrawl() {
  if (process.env.VERCEL) {
    logger.info('crawler_scheduler_skipped', { reason: 'running_on_vercel' });
    return;
  }

  const stale = isStale();

  if (stale) {
    // Delay 10s so server fully boots before crawl starts
    logger.info('crawler_scheduler_will_run_on_startup', { delay_s: 10 });
    setTimeout(() => runCrawler('startup_stale_or_first_run'), 10_000);
  }

  // Schedule every 24h
  _intervalHandle = setInterval(() => runCrawler('scheduled_24h'), INTERVAL_MS);
  if (_intervalHandle.unref) _intervalHandle.unref();

  logger.info('crawler_scheduler_ready', {
    auto_run_every: '24h',
    immediate_startup_run: stale
  });
}

module.exports = { scheduleAutoCrawl, runCrawler };
