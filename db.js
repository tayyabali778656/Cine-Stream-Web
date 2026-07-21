'use strict';

/**
 * db.js — MongoDB connection with env-based URI and collection indexing
 *
 * All credentials come from config.js (which reads from .env).
 * Indexes are created on first connection to ensure query performance.
 */

const { MongoClient } = require('mongodb');
const dns    = require('dns');
const config = require('./config');
const logger = require('./utils/logger');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  logger.warn('DNS override failed — using system default', { message: e.message });
}

const client = new MongoClient(config.mongoUri, {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 15_000,
  family: 4,              // Force IPv4 — resolves DNS-related SSL issues on Node 24
  tls: true,
});

let db = null;

// ── Index definitions ──────────────────────────────────────────────────────────
const INDEX_DEFS = [
  { collection: 'admin_store',     index: { id: 1 }, options: { unique: true } },
  { collection: 'broken_videos',   index: { id: 1 }, options: { unique: true } },
  { collection: 'missing_catalog', index: { id: 1 }, options: { unique: true } },
  { collection: 'hidden_items',    index: { id: 1 }, options: { unique: true } },
  { collection: 'hindi_dubbed',    index: { id: 1 }, options: { unique: true } },
  { collection: 'anime',           index: { id: 1 }, options: { unique: true } },
  { collection: 'anime',           index: { slug: 1 }, options: { unique: true } },
  { collection: 'episodes',        index: { animeId: 1 } },
  { collection: 'episodes',        index: { url: 1 }, options: { unique: true } },
  { collection: 'genres',          index: { name: 1 }, options: { unique: true } },
  { collection: 'featured',        index: { animeId: 1 }, options: { unique: true } },
  { collection: 'latest',          index: { animeId: 1 }, options: { unique: true } },
  { collection: 'popular',          index: { animeId: 1 }, options: { unique: true } },
];

async function createIndexes() {
  for (const { collection, index, options } of INDEX_DEFS) {
    try {
      await db.collection(collection).createIndex(index, { background: true, ...options });
    } catch (err) {
      // Index may already exist — that's fine
      if (!err.message.includes('already exists') && err.code !== 85) {
        logger.warn(`Index creation warning on ${collection}`, { message: err.message });
      }
    }
  }
  logger.info('db_indexes_ensured', { collections: INDEX_DEFS.map(d => d.collection) });
}

async function connectDB() {
  if (db) return db;
  const start = Date.now();
  try {
    await client.connect();
    db = client.db('moviebox');
    const durationMs = Date.now() - start;
    logger.info('db_connected', { duration_ms: durationMs, uri: config.mongoUri.split('@')[1] || 'local' });
    await createIndexes();
    return db;
  } catch (err) {
    logger.error('db_connection_failed', err);
    throw err;
  }
}

const mockDb = {
  collection: (name) => ({
    find: () => ({
      toArray: async () => [],
      skip: () => ({
        limit: () => ({
          toArray: async () => []
        }),
        toArray: async () => []
      }),
      limit: () => ({
        toArray: async () => []
      })
    }),
    findOne: async () => null,
    createIndex: async () => {},
    updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    insertOne: async () => ({ insertedId: null }),
    deleteMany: async () => ({ deletedCount: 0 }),
    bulkWrite: async () => ({})
  })
};

function getCollection(name) {
  if (!db) {
    logger.warn(`db_not_initialized_using_mock_database`, {
      collection: name,
      error: 'MongoDB is not connected. All database reads/writes will revert on page reload.',
      tip: 'Please ensure that the MONGODB_URI environment variable is correctly set in your Vercel project settings.'
    });
    return mockDb.collection(name);
  }
  return db.collection(name);
}

function isConnected() {
  return db !== null;
}

module.exports = { connectDB, getCollection, isConnected };
