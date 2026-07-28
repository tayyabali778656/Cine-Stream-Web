'use strict';

/**
 * scripts/fixSitemapNow.js
 *
 * One-time fix script for existing sitemap.xml:
 *  1. Removes garbage/invalid URLs (global_settings, etc.)
 *  2. Fixes double-encoded HTML entities in image:title and image:caption
 *  3. Updates all lastmod dates to today
 *  4. Cleans up malformed whitespace in captions
 *
 * Run: node scripts/fixSitemapNow.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT_DIR    = path.join(__dirname, '..');
const SITEMAP_IN  = path.join(ROOT_DIR, 'sitemap.xml');
const SITEMAP_OUT = path.join(ROOT_DIR, 'sitemap.xml');
const BACKUP_PATH = path.join(ROOT_DIR, 'sitemap.xml.bak');

const TODAY = new Date().toISOString().split('T')[0];

// IDs to block (garbage entries that should never be in sitemap)
const BLOCKED_IDS = new Set([
  'global_settings', 'settings', 'config', 'admin', 'test',
  'undefined', 'null', 'none', 'placeholder'
]);

// ── Decode HTML entities from text ─────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    // Un-double-encode: &amp;rsquo; → &rsquo;, &amp;mdash; → &mdash; etc.
    .replace(/&amp;(#?\w+;)/g, '&$1')
    // Decode common HTML entities to plain text
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')   // strip remaining numeric HTML entities
    // Clean up whitespace (including \r\n and multiple spaces)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── XML-escape plain text ───────────────────────────────────────────────────
function escapeXml(str) {
  if (!str) return '';
  return decodeHtmlEntities(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// ── Check if a URL slug is valid content ───────────────────────────────────
function isBlockedId(urlPath) {
  const segments = urlPath.split('/');
  const lastSeg  = segments[segments.length - 1];
  return BLOCKED_IDS.has(lastSeg.toLowerCase());
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('\n🔧 CineStream Sitemap Fixer');
console.log('══════════════════════════════\n');

if (!fs.existsSync(SITEMAP_IN)) {
  console.error('❌ sitemap.xml not found at:', SITEMAP_IN);
  process.exit(1);
}

// Backup original
fs.copyFileSync(SITEMAP_IN, BACKUP_PATH);
console.log('📋 Backup saved to sitemap.xml.bak');

let xml = fs.readFileSync(SITEMAP_IN, 'utf8');
const originalSize = xml.length;

// ── Step 1: Extract all <url>...</url> blocks ───────────────────────────────
const urlBlockRegex = /<url>[\s\S]*?<\/url>/g;
const allBlocks     = xml.match(urlBlockRegex) || [];
console.log(`\n📊 Total URL blocks found: ${allBlocks.length}`);

let removedGarbage  = 0;
let fixedEntities   = 0;
let updatedLastmod  = 0;
const cleanBlocks   = [];

for (const block of allBlocks) {
  // Extract <loc>
  const locMatch = block.match(/<loc>(.*?)<\/loc>/);
  if (!locMatch) continue;
  const loc = locMatch[1].trim();

  // Step 1a: Remove garbage/blocked URLs
  if (isBlockedId(loc)) {
    console.log(`  🗑  Removing garbage URL: ${loc}`);
    removedGarbage++;
    continue;
  }

  let cleanBlock = block;

  // Step 1b: Fix double-encoded entities in image:title
  cleanBlock = cleanBlock.replace(
    /<image:title>([\s\S]*?)<\/image:title>/g,
    (match, content) => {
      const fixed = escapeXml(content);
      if (fixed !== content) fixedEntities++;
      return `<image:title>${fixed}</image:title>`;
    }
  );

  // Step 1c: Fix double-encoded entities + whitespace in image:caption
  cleanBlock = cleanBlock.replace(
    /<image:caption>([\s\S]*?)<\/image:caption>/g,
    (match, content) => {
      const decoded = decodeHtmlEntities(content);
      // Limit caption to 200 chars and re-escape cleanly
      const trimmed = decoded.slice(0, 200);
      const fixed   = escapeXml(trimmed);
      if (fixed !== content.trim()) fixedEntities++;
      return `<image:caption>${fixed}</image:caption>`;
    }
  );

  // Step 1d: Update lastmod to today
  cleanBlock = cleanBlock.replace(
    /<lastmod>[^<]*<\/lastmod>/,
    `<lastmod>${TODAY}</lastmod>`
  );
  updatedLastmod++;

  cleanBlocks.push(cleanBlock);
}

console.log(`\n📈 Results:`);
console.log(`   ✅ Kept: ${cleanBlocks.length} URLs`);
console.log(`   🗑  Removed garbage URLs: ${removedGarbage}`);
console.log(`   🔧 Fixed HTML entity encodings: ${fixedEntities} tags`);
console.log(`   📅 Updated lastmod to ${TODAY}: ${updatedLastmod} entries`);

// ── Step 2: Rebuild sitemap XML ─────────────────────────────────────────────
const header = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">`;

const footer = `\n</urlset>`;

const newXml = header + '\n' + cleanBlocks.join('\n') + footer;

fs.writeFileSync(SITEMAP_OUT, newXml, 'utf8');

const newSize = newXml.length;
const saved   = ((originalSize - newSize) / 1024).toFixed(1);

console.log(`\n💾 Written: sitemap.xml`);
console.log(`   Original size: ${(originalSize / 1024).toFixed(1)} KB`);
console.log(`   New size:      ${(newSize / 1024).toFixed(1)} KB`);
console.log(`   Saved:         ${saved} KB`);
console.log('\n✅ Done! Now re-submit sitemap in Google Search Console.\n');
