/**
 * Run: node --test src/services/arDocumentOpen.service.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  buildOpenByDeliveryFromDocumentAllocations,
  allocateReturnToOrderDeliveries,
  allocateCollectionFifo
} = require('./arDocumentOpen.service');

describe('arDocumentOpen.service', () => {
  test('buildOpenByDeliveryFromDocumentAllocations — conservation', () => {
    const d1 = new mongoose.Types.ObjectId();
    const d2 = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [
        { _id: d1, pharmacyNetPayable: 1900 },
        { _id: d2, pharmacyNetPayable: 4125 }
      ],
      returnAllocations: [{ deliveryId: d1, amount: 1900 }],
      collectionAllocations: [{ deliveryId: d2, amount: 800 }]
    });
    assert.equal(openByDelivery[String(d1)], 0);
    assert.equal(openByDelivery[String(d2)], 3325);
    assert.equal(pharmacyOpen, 3325);
  });

  test('Life-style ghost pin would overstate if open used max(0) without conservation', () => {
    const returned = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [
        { _id: returned, pharmacyNetPayable: 1900 },
        { _id: other, pharmacyNetPayable: 5500 }
      ],
      returnAllocations: [{ deliveryId: returned, amount: 1900 }],
      collectionAllocations: [
        { deliveryId: returned, amount: 1200 },
        { deliveryId: other, amount: 800 }
      ]
    });
    assert.equal(openByDelivery[String(returned)], -1200);
    assert.equal(openByDelivery[String(other)], 4700);
    assert.equal(pharmacyOpen, 3500);
    const brokenSumMax0 =
      Math.max(0, openByDelivery[String(returned)]) + Math.max(0, openByDelivery[String(other)]);
    assert.equal(brokenSumMax0, 4700);
    assert.notEqual(brokenSumMax0, pharmacyOpen);
  });

  test('allocateReturnToOrderDeliveries — order scoped', () => {
    const d1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const d2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const open = { [d1]: 1000, [d2]: 900 };
    const { allocations, leftover } = allocateReturnToOrderDeliveries(open, 1900, [d1, d2]);
    assert.equal(leftover, 0);
    assert.equal(allocations.length, 2);
    assert.equal(open[d1], 0);
    assert.equal(open[d2], 0);
  });

  test('allocateCollectionFifo — by deliveredAt', () => {
    const d1 = new mongoose.Types.ObjectId();
    const d2 = new mongoose.Types.ObjectId();
    const { allocations, leftover } = allocateCollectionFifo(2000, [
      { deliveryId: d2, orderId: d2, distributorId: null, deliveredAt: new Date('2026-05-08'), open: 3325 },
      { deliveryId: d1, orderId: d1, distributorId: null, deliveredAt: new Date('2026-05-01'), open: 100 }
    ]);
    assert.equal(leftover, 0);
    assert.equal(String(allocations[0].deliveryId), String(d1));
    assert.equal(allocations[0].amount, 100);
    assert.equal(allocations[1].amount, 1900);
  });

  test('unpaid invoice + amendment reduces open', () => {
    const d1 = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [{ _id: d1, pharmacyNetPayable: 10000 }],
      amendmentAllocations: [{ deliveryId: d1, amount: 5000 }]
    });
    assert.equal(openByDelivery[String(d1)], 5000);
    assert.equal(pharmacyOpen, 5000);
  });

  test('partially paid invoice + amendment', () => {
    const d1 = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [{ _id: d1, pharmacyNetPayable: 10000 }],
      collectionAllocations: [{ deliveryId: d1, amount: 3000 }],
      amendmentAllocations: [{ deliveryId: d1, amount: 2000 }]
    });
    assert.equal(openByDelivery[String(d1)], 5000);
    assert.equal(pharmacyOpen, 5000);
  });

  test('fully paid invoice + amendment → customer credit (negative open)', () => {
    const d1 = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [{ _id: d1, pharmacyNetPayable: 10000 }],
      collectionAllocations: [{ deliveryId: d1, amount: 10000 }],
      amendmentAllocations: [{ deliveryId: d1, amount: 4000 }]
    });
    assert.equal(openByDelivery[String(d1)], -4000);
    assert.equal(pharmacyOpen, -4000);
  });

  test('multiple amendments sum correctly', () => {
    const d1 = new mongoose.Types.ObjectId();
    const { pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [{ _id: d1, pharmacyNetPayable: 10000 }],
      amendmentAllocations: [
        { deliveryId: d1, amount: 2000 },
        { deliveryId: d1, amount: 1500 }
      ]
    });
    assert.equal(pharmacyOpen, 6500);
  });

  test('amendment after partial return', () => {
    const d1 = new mongoose.Types.ObjectId();
    const { pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [{ _id: d1, pharmacyNetPayable: 10000 }],
      returnAllocations: [{ deliveryId: d1, amount: 2500 }],
      amendmentAllocations: [{ deliveryId: d1, amount: 1500 }]
    });
    assert.equal(pharmacyOpen, 6000);
  });

  test('amendment combined with collections interleaved composition', () => {
    const d1 = new mongoose.Types.ObjectId();
    const d2 = new mongoose.Types.ObjectId();
    const { openByDelivery, pharmacyOpen } = buildOpenByDeliveryFromDocumentAllocations({
      deliveries: [
        { _id: d1, pharmacyNetPayable: 5000 },
        { _id: d2, pharmacyNetPayable: 5000 }
      ],
      collectionAllocations: [
        { deliveryId: d1, amount: 2000 },
        { deliveryId: d2, amount: 1000 }
      ],
      amendmentAllocations: [{ deliveryId: d1, amount: 1000 }],
      returnAllocations: [{ deliveryId: d2, amount: 500 }]
    });
    assert.equal(openByDelivery[String(d1)], 2000);
    assert.equal(openByDelivery[String(d2)], 3500);
    assert.equal(pharmacyOpen, 5500);
  });
});
