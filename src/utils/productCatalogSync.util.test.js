/**
 * Run: node --test src/utils/productCatalogSync.util.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  buildProductSyncFilter,
  paginateSyncDocs
} = require('./productCatalogSync.util');

describe('buildProductSyncFilter', () => {
  test('first page uses catalogVersion > sinceVersion', () => {
    const companyId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildProductSyncFilter(companyId, 47, null), {
      companyId,
      catalogVersion: { $gt: 47 }
    });
  });

  test('continuation page uses composite (version, _id) cursor', () => {
    const companyId = new mongoose.Types.ObjectId();
    const sinceId = new mongoose.Types.ObjectId();
    const filter = buildProductSyncFilter(companyId, 1, String(sinceId));
    assert.equal(filter.companyId, companyId);
    assert.equal(filter.$or.length, 2);
    assert.deepEqual(filter.$or[0], { catalogVersion: { $gt: 1 } });
    assert.deepEqual(filter.$or[1], { catalogVersion: 1, _id: { $gt: sinceId } });
  });

  test('invalid sinceId falls back to version-only filter', () => {
    const companyId = new mongoose.Types.ObjectId();
    assert.deepEqual(buildProductSyncFilter(companyId, 3, 'not-an-object-id'), {
      companyId,
      catalogVersion: { $gt: 3 }
    });
  });
});

describe('paginateSyncDocs', () => {
  test('detects hasMore when an extra row was fetched', () => {
    const docs = [
      { _id: 'a', catalogVersion: 1 },
      { _id: 'b', catalogVersion: 1 },
      { _id: 'c', catalogVersion: 2 }
    ];
    const page = paginateSyncDocs(docs, 2, 0);
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.lastId, 'b');
    assert.equal(page.maxFromItems, 1);
  });

  test('returns hasMore=false when page is not full', () => {
    const docs = [{ _id: 'a', catalogVersion: 48 }];
    const page = paginateSyncDocs(docs, 2, 47);
    assert.equal(page.hasMore, false);
    assert.equal(page.maxFromItems, 48);
    assert.equal(page.lastId, 'a');
  });
});
