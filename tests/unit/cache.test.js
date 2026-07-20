'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cache = require('../../services/cache');

test('LRU Cache Service Unit Tests', async (t) => {
  await t.test('should set and get values correctly', () => {
    cache.clear();
    cache.set('test-key', { foo: 'bar' });
    const val = cache.get('test-key');
    assert.deepStrictEqual(val, { foo: 'bar' });
  });

  await t.test('should return null for expired entries', () => {
    cache.clear();
    cache.set('expire-key', 'value', 1); // 1ms TTL
    
    // Wait 5ms for expiry
    return new Promise((resolve) => {
      setTimeout(() => {
        const val = cache.get('expire-key');
        assert.strictEqual(val, null);
        resolve();
      }, 5);
    });
  });

  await t.test('should delete entries by prefix', () => {
    cache.clear();
    cache.set('prefix_one', 1);
    cache.set('prefix_two', 2);
    cache.set('other_key', 3);

    const deletedCount = cache.deleteByPrefix('prefix_');
    assert.strictEqual(deletedCount, 2);
    assert.strictEqual(cache.get('prefix_one'), null);
    assert.strictEqual(cache.get('prefix_two'), null);
    assert.strictEqual(cache.get('other_key'), 3);
  });
});
