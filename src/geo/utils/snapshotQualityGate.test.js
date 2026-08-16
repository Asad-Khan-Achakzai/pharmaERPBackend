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

test('shouldUpdateSnapshot rejects teleports even on the periodic refresh path', () => {
  // Real production pattern: Quetta → Changsha (4,460 km) with excellent accuracy.
  const existing = {
    lat: 30.1975,
    lng: 67.0128,
    accuracy: 15,
    confidence: 60,
    capturedAt: new Date('2026-07-06T10:00:00.000Z')
  };
  const teleport = {
    lat: 28.1918,
    lng: 113.2236,
    accuracy: 11,
    confidence: 70,
    capturedAt: new Date('2026-07-06T10:04:00.000Z') // 4 min → periodic refresh window
  };
  assert.equal(shouldUpdateSnapshot(teleport, existing), false);
});

test('shouldUpdateSnapshot accepts legit highway movement (~39 m/s)', () => {
  const existing = {
    lat: 30.0,
    lng: 67.0,
    accuracy: 20,
    confidence: 55,
    capturedAt: new Date('2026-07-06T10:00:00.000Z')
  };
  const incoming = {
    lat: 30.0213, // ~2.37 km in 60s = 39.4 m/s
    lng: 67.0,
    accuracy: 20,
    confidence: 55,
    capturedAt: new Date('2026-07-06T10:01:00.000Z')
  };
  assert.equal(shouldUpdateSnapshot(incoming, existing), true);
});

test('shouldUpdateSnapshot unblocks a far fix once the pin is stale (>15 min)', () => {
  const existing = {
    lat: 30.1975,
    lng: 67.0128,
    accuracy: 15,
    confidence: 60,
    capturedAt: new Date('2026-07-06T10:00:00.000Z')
  };
  const farButStale = {
    lat: 31.5204, // ~160 km away
    lng: 74.3587,
    accuracy: 20,
    confidence: 60,
    capturedAt: new Date('2026-07-06T10:20:00.000Z') // 20 min later
  };
  assert.equal(shouldUpdateSnapshot(farButStale, existing), true);
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
