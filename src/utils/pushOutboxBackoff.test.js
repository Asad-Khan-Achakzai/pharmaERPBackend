/**
 * Run: node --test src/utils/pushOutboxBackoff.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ATTEMPTS,
  nextAttemptAt,
  isPermanentPushError,
  BACKOFF_MS
} = require('./pushOutboxBackoff');

describe('pushOutboxBackoff', () => {
  test('MAX_ATTEMPTS is 5', () => {
    assert.equal(MAX_ATTEMPTS, 5);
    assert.equal(BACKOFF_MS.length, 5);
  });

  test('nextAttemptAt increases with attempts', () => {
    const a1 = nextAttemptAt(1).getTime();
    const a5 = nextAttemptAt(5).getTime();
    assert.ok(a5 > a1);
  });

  test('classifies DeviceNotRegistered as permanent', () => {
    assert.equal(isPermanentPushError({ message: 'DeviceNotRegistered' }), true);
    assert.equal(isPermanentPushError({ code: 'DeviceNotRegistered' }), true);
    assert.equal(isPermanentPushError({ message: 'network timeout' }), false);
  });
});
