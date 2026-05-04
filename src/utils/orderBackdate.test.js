/**
 * Run: node --test src/utils/orderBackdate.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertValidBackdateWindow,
  assertDeliveryNotBeforeOrder,
  isStrictlyBackdatedCalendarDay
} = require('./orderBackdate');

describe('orderBackdate', () => {
  test('allows today', () => {
    const now = new Date('2026-05-15T14:00:00.000Z');
    assert.doesNotThrow(() => assertValidBackdateWindow('2026-05-15', now, 'UTC'));
  });

  test('rejects future calendar day (UTC)', () => {
    const now = new Date('2026-05-15T14:00:00.000Z');
    assert.throws(() => assertValidBackdateWindow('2026-05-16', now, 'UTC'), /future/i);
  });

  test('rejects too far in the past', () => {
    const now = new Date('2026-05-15T14:00:00.000Z');
    assert.throws(() => assertValidBackdateWindow('2026-04-14', now, 'UTC'), /more than/i);
  });

  test('delivery before order day throws', () => {
    assert.throws(
      () => assertDeliveryNotBeforeOrder('2026-05-10', '2026-05-11', 'UTC'),
      /before order date/i
    );
  });

  test('delivery same calendar day as order ok', () => {
    assert.doesNotThrow(() =>
      assertDeliveryNotBeforeOrder('2026-05-11T18:00:00.000Z', '2026-05-11T09:00:00.000Z', 'UTC')
    );
  });

  test('isStrictlyBackdatedCalendarDay', () => {
    const ref = new Date('2026-05-15T12:00:00.000Z');
    assert.equal(isStrictlyBackdatedCalendarDay('2026-05-14', ref, 'UTC'), true);
    assert.equal(isStrictlyBackdatedCalendarDay('2026-05-15', ref, 'UTC'), false);
  });
});
