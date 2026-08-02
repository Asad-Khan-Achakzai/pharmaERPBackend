/**
 * Run: node --test src/services/tax/taxEngine.service.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRateVersion, startOfUtcDay } = require('./taxEngine.service');

describe('taxEngine.resolveRateVersion', () => {
  test('picks open-ended rate covering business date', () => {
    const versions = [
      {
        _id: 'a',
        ratePercent: 0.5,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: null
      }
    ];
    const rv = resolveRateVersion(versions, new Date('2026-08-01T12:00:00.000Z'));
    assert.equal(rv.ratePercent, 0.5);
  });

  test('respects effectiveTo boundary', () => {
    const versions = [
      {
        _id: 'old',
        ratePercent: 0.5,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2025-12-31T00:00:00.000Z')
      },
      {
        _id: 'new',
        ratePercent: 0.75,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null
      }
    ];
    assert.equal(resolveRateVersion(versions, new Date('2025-06-01')).ratePercent, 0.5);
    assert.equal(resolveRateVersion(versions, new Date('2026-06-01')).ratePercent, 0.75);
  });

  test('returns null when no schedule covers date', () => {
    const versions = [
      {
        ratePercent: 0.5,
        effectiveFrom: new Date('2030-01-01T00:00:00.000Z'),
        effectiveTo: null
      }
    ];
    assert.equal(resolveRateVersion(versions, new Date('2026-01-01')), null);
  });

  test('startOfUtcDay normalizes', () => {
    const d = startOfUtcDay(new Date('2026-08-01T15:30:00.000Z'));
    assert.equal(d.toISOString(), '2026-08-01T00:00:00.000Z');
  });
});
