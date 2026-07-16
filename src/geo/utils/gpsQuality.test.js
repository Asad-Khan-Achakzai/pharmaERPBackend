const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGpsQuality,
  resolveAccuracyPolicy
} = require('./gpsQuality');

const policy = resolveAccuracyPolicy({
  maxAccuracyMeters: 150,
  historyMaxAccuracyMeters: 500
});

test('null accuracy is live-eligible acceptable', () => {
  const r = classifyGpsQuality(null, policy);
  assert.equal(r.qualityLevel, 'acceptable');
  assert.equal(r.usableForLive, true);
  assert.equal(r.retainForHistory, true);
});

test('excellent / good / acceptable bands', () => {
  assert.equal(classifyGpsQuality(20, policy).qualityLevel, 'excellent');
  assert.equal(classifyGpsQuality(50, policy).qualityLevel, 'good');
  assert.equal(classifyGpsQuality(120, policy).qualityLevel, 'acceptable');
  assert.equal(classifyGpsQuality(120, policy).usableForLive, true);
});

test('history-only low_confidence between live and history max', () => {
  const r = classifyGpsQuality(200, policy);
  assert.equal(r.qualityLevel, 'low_confidence');
  assert.equal(r.usableForLive, false);
  assert.equal(r.retainForHistory, true);
});

test('invalid above history max', () => {
  const r = classifyGpsQuality(600, policy);
  assert.equal(r.qualityLevel, 'invalid');
  assert.equal(r.retainForHistory, false);
});

test('history ceiling never stricter than live', () => {
  const p = resolveAccuracyPolicy({
    maxAccuracyMeters: 200,
    historyMaxAccuracyMeters: 100
  });
  assert.equal(p.historyMaxAccuracyMeters, 200);
});
