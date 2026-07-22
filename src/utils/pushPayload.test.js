/**
 * Run: node --test src/utils/pushPayload.test.js src/utils/pushOutboxBackoff.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePushContent, buildPushData, channelIdForMeta } = require('./pushPayload');
const { NOTIFICATION_KIND } = require('../constants/enums');

describe('pushPayload.sanitizePushContent', () => {
  test('sanitizes expense PII from lock-screen copy', () => {
    const out = sanitizePushContent({
      kind: NOTIFICATION_KIND.EXPENSE,
      title: 'Expense pending',
      body: 'Travel — Rs 5000'
    });
    assert.equal(out.title, 'Expense update');
    assert.ok(!out.body.includes('5000'));
  });

  test('sanitizes attendance names', () => {
    const out = sanitizePushContent({
      kind: NOTIFICATION_KIND.ATTENDANCE,
      title: 'Late check-in',
      body: 'Ali checked in 20m late'
    });
    assert.equal(out.title, 'Attendance update');
    assert.ok(!out.body.includes('Ali'));
  });

  test('sanitizes weekly plan', () => {
    const out = sanitizePushContent({
      kind: NOTIFICATION_KIND.WEEKLY_PLAN,
      title: 'Weekly plan pending',
      body: 'Ali submitted'
    });
    assert.equal(out.title, 'Weekly plan update');
  });

  test('keeps announcement body', () => {
    const out = sanitizePushContent({
      kind: NOTIFICATION_KIND.ANNOUNCEMENT,
      title: 'Holiday',
      body: 'Office closed Friday'
    });
    assert.equal(out.title, 'Holiday');
    assert.equal(out.body, 'Office closed Friday');
  });
});

describe('pushPayload.buildPushData', () => {
  test('includes routing ids only', () => {
    const data = buildPushData({
      notificationId: 'abc',
      kind: NOTIFICATION_KIND.EXPENSE,
      link: '/expenses',
      meta: { expenseId: 'e1', secretName: 'should-not-appear', category: 'approvals' }
    });
    assert.equal(data.notificationId, 'abc');
    assert.equal(data.expenseId, 'e1');
    assert.equal(data.link, '/expenses');
    assert.equal(data.category, 'approvals');
    assert.equal(data.secretName, undefined);
  });
});

describe('pushPayload.channelIdForMeta', () => {
  test('maps approvals category', () => {
    assert.equal(channelIdForMeta({ category: 'approvals' }), 'approvals');
    assert.equal(channelIdForMeta({ category: 'broadcast' }), 'announcements');
    assert.equal(channelIdForMeta({}), 'default');
  });
});
