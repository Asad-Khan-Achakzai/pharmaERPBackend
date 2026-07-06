const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldUpdateSnapshot } = require('./snapshotQualityGate');
const { pickBestLocationFix } = require('../../services/liveTracking.service');

test('shouldUpdateSnapshot refreshes after periodic interval even when stationary', () => {
  const existing = {
    lat: 30.17,
    lng: 67.01,
    accuracy: 16,
    confidence: 55,
    capturedAt: new Date('2026-07-06T10:00:00.000Z')
  };
  const incoming = {
    lat: 30.1701,
    lng: 67.0101,
    accuracy: 18,
    confidence: 54,
    capturedAt: new Date('2026-07-06T10:04:00.000Z')
  };
  assert.equal(shouldUpdateSnapshot(incoming, existing), true);
});

test('pickBestLocationFix prefers newer heartbeat over older snapshot', () => {
  const snapshot = {
    lat: 30.17,
    lng: 67.01,
    capturedAt: new Date('2026-07-06T10:00:00.000Z'),
    uploadedAt: new Date('2026-07-06T10:00:05.000Z')
  };
  const heartbeat = {
    lat: 30.1704,
    lng: 67.0116,
    capturedAt: new Date('2026-07-06T10:21:00.000Z')
  };
  const best = pickBestLocationFix(snapshot, heartbeat);
  assert.equal(best, heartbeat);
});
