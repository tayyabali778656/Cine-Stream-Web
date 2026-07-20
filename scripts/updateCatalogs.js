'use strict';

/**
 * scripts/updateCatalogs.js
 * Aliased wrapper to invoke the new ToonStream Anime crawler.
 */

const crawler = require('./toonstreamCrawler');
// Just run the crawler
// Run if executed directly
if (require.main === module) {
  crawler.run();
}
