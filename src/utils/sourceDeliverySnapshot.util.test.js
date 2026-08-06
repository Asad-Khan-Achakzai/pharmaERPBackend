const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSourceDeliverySnapshot,
  classifySourceDeliveryPeriod
} = require('./sourceDeliverySnapshot.util');

describe('sourceDeliverySnapshot', () => {
  it('builds ym from deliveredAt in company TZ', () => {
    const snap = buildSourceDeliverySnapshot(
      {
        _id: 'del1',
        deliveredAt: new Date('2026-06-29T18:30:00.000Z'),
        invoiceNumber: 'INV-1'
      },
      'Asia/Karachi'
    );
    assert.equal(snap.sourceDeliveryYm, '2026-06');
    assert.equal(snap.sourceInvoiceNumber, 'INV-1');
    assert.ok(snap.sourceDeliveredAt);
  });

  it('returns null snapshot when delivery missing', () => {
    const snap = buildSourceDeliverySnapshot(null, 'Asia/Karachi');
    assert.equal(snap.sourceDeliveryId, null);
    assert.equal(snap.sourceDeliveryYm, null);
  });

  it('classifies current vs prior period', () => {
    assert.equal(classifySourceDeliveryPeriod('2026-07', '2026-07'), 'currentPeriod');
    assert.equal(classifySourceDeliveryPeriod('2026-07', '2026-06'), 'priorPeriod');
    assert.equal(classifySourceDeliveryPeriod('2026-07', null), 'unclassified');
    assert.equal(classifySourceDeliveryPeriod('2026-07', '2026-08'), 'unclassified');
  });
});
