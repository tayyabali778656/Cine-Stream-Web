'use strict';

/**
 * services/queue.js — Lightweight async job queue
 *
 * Processes background tasks (broken video reports, catalog checks,
 * missing catalog updates, admin cache sync) without blocking the
 * HTTP request/response cycle.
 *
 * Architecture:
 *   Client POST → immediate 202 response → job queued → worker processes
 *
 * Features:
 * - Retry with exponential backoff (up to 3 retries)
 * - Failed jobs logged for admin visibility
 * - Job deduplication by key (no duplicate catalog checks for same movie ID)
 */

const logger = require('../utils/logger');

// ── Job Types ─────────────────────────────────────────────────────────────────
const JOB_TYPES = {
  REPORT_BROKEN_VIDEO:    'REPORT_BROKEN_VIDEO',
  REPORT_MISSING_CATALOG: 'REPORT_MISSING_CATALOG',
  DELETE_BROKEN_VIDEO:    'DELETE_BROKEN_VIDEO',
  SYNC_ADMIN_CACHE:       'SYNC_ADMIN_CACHE',
};

// ── Internal state ────────────────────────────────────────────────────────────
const jobQueue  = []; // FIFO array of pending jobs
const failedJobs = []; // Jobs that exhausted retries (max 100 stored)
const seenKeys  = new Set(); // Deduplication: prevents identical jobs within a window
let isProcessing = false;

let dbRef = null; // Injected at startup: { getCollection }

// ── Queue a job ───────────────────────────────────────────────────────────────
/**
 * Add a job to the queue.
 * @param {string} type - One of JOB_TYPES
 * @param {object} payload - Job data
 * @param {string} [dedupeKey] - If provided, skip if an identical key is already queued
 */
function enqueue(type, payload, dedupeKey = null) {
  if (dedupeKey && seenKeys.has(dedupeKey)) {
    logger.debug('queue_dedupe', { type, dedupeKey });
    return;
  }
  if (dedupeKey) {
    seenKeys.add(dedupeKey);
    // Remove dedupe key after 30 minutes to allow re-queuing
    setTimeout(() => seenKeys.delete(dedupeKey), 30 * 60 * 1000).unref();
  }

  const job = { type, payload, attempts: 0, maxAttempts: 3, createdAt: Date.now() };
  jobQueue.push(job);
  logger.debug('queue_enqueue', { type, queueLength: jobQueue.length });
  scheduleProcessing();
}

// ── Process jobs ──────────────────────────────────────────────────────────────
function scheduleProcessing() {
  if (!isProcessing) {
    setImmediate(processNext);
  }
}

async function processNext() {
  if (jobQueue.length === 0) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const job = jobQueue.shift();

  try {
    await executeJob(job);
    logger.debug('queue_job_done', { type: job.type });
  } catch (err) {
    job.attempts++;
    if (job.attempts < job.maxAttempts) {
      const delay = Math.pow(2, job.attempts) * 1000; // 2s, 4s, 8s
      logger.warn('queue_job_retry', { type: job.type, attempt: job.attempts, delay_ms: delay });
      setTimeout(() => {
        jobQueue.unshift(job); // Re-insert at front for retry
        scheduleProcessing();
      }, delay).unref();
    } else {
      logger.error('queue_job_failed', { type: job.type, error: err.message });
      failedJobs.unshift({ ...job, failedAt: Date.now(), error: err.message });
      if (failedJobs.length > 100) failedJobs.pop(); // Keep max 100 failed jobs
    }
  }

  // Process next job
  setImmediate(processNext);
}

// ── Job executors ─────────────────────────────────────────────────────────────
async function executeJob(job) {
  if (!dbRef) throw new Error('Database not injected into queue service');
  const { type, payload } = job;

  switch (type) {
    case JOB_TYPES.REPORT_BROKEN_VIDEO: {
      const col = dbRef.getCollection('broken_videos');
      await col.updateOne(
        { id: payload.id },
        { $set: { ...payload, reportedAt: new Date() } },
        { upsert: true }
      );
      break;
    }

    case JOB_TYPES.REPORT_MISSING_CATALOG: {
      const col = dbRef.getCollection('missing_catalog');
      await col.updateOne(
        { id: payload.id },
        { $set: { ...payload, detectedAt: new Date() } },
        { upsert: true }
      );
      break;
    }

    case JOB_TYPES.DELETE_BROKEN_VIDEO: {
      const col = dbRef.getCollection('broken_videos');
      await col.deleteOne({ id: payload.id });
      break;
    }

    case JOB_TYPES.SYNC_ADMIN_CACHE: {
      // No-op for now; future: emit event to refresh server-side cache
      logger.info('queue_sync_admin_cache');
      break;
    }

    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

// ── Stats for /health endpoint ────────────────────────────────────────────────
function getStats() {
  return {
    pending: jobQueue.length,
    failed: failedJobs.length,
    dedupe_keys: seenKeys.size,
    is_processing: isProcessing,
  };
}

// ── Inject DB reference ───────────────────────────────────────────────────────
function injectDb(db) {
  dbRef = db;
}

module.exports = { enqueue, getStats, injectDb, JOB_TYPES };
