'use strict';

/**
 * services/catalogService.js
 *
 * Previously loaded 9xmovies/allmovieland catalog JSON files.
 * Now DEPRECATED — the site uses ToonStream MongoDB collections instead.
 * Kept as a stub for backward compatibility with existing require() calls.
 */

const logger = require('../utils/logger');

async function loadCatalogs() {
  logger.info('catalog_load_skipped', { reason: 'Replaced by ToonStream MongoDB collections' });
  return;
}

function checkCatalog(title) {
  return { has9x: false, hasAll: false, inCatalog: true }; // fail-open
}

function getStats() {
  return {
    catalog9x_count: 0,
    catalogAll_count: 0,
    last_loaded: 'n/a (using ToonStream DB)',
  };
}

module.exports = { loadCatalogs, checkCatalog, getStats };
