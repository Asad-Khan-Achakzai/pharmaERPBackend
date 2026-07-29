/**
 * Run: node --test src/services/outstandingCollections.service.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  resolveOutstandingRepId,
  deriveInvoicePaymentStatus,
  areaZoneFromTerritory,
  aggregateRows,
  buildOpenByDeliveryFromLedgerLines,
  GROUP_BY,
  PAYMENT_STATUS
} = require('./outstandingCollections.service');
const { TERRITORY_KIND } = require('../constants/enums');

describe('outstandingCollections.service helpers', () => {
  test('resolveOutstandingRepId — uses order.medicalRepId', () => {
    const repId = new mongoose.Types.ObjectId();
    assert.equal(String(resolveOutstandingRepId({ order: { medicalRepId: repId } })), String(repId));
  });

  test('resolveOutstandingRepId — populated medicalRepId', () => {
    const repId = new mongoose.Types.ObjectId();
    assert.equal(
      String(resolveOutstandingRepId({ order: { medicalRepId: { _id: repId, name: 'A' } } })),
      String(repId)
    );
  });

  test('resolveOutstandingRepId — missing order returns null', () => {
    assert.equal(resolveOutstandingRepId({ order: null }), null);
    assert.equal(resolveOutstandingRepId({ order: {} }), null);
  });

  test('deriveInvoicePaymentStatus', () => {
    assert.equal(deriveInvoicePaymentStatus(0, 0), null);
    assert.equal(deriveInvoicePaymentStatus(100, 0), PAYMENT_STATUS.PAID);
    assert.equal(deriveInvoicePaymentStatus(100, 100), PAYMENT_STATUS.UNPAID);
    assert.equal(deriveInvoicePaymentStatus(100, 40), PAYMENT_STATUS.PARTIALLY_PAID);
  });

  test('areaZoneFromTerritory — brick path', () => {
    const zoneId = new mongoose.Types.ObjectId();
    const areaId = new mongoose.Types.ObjectId();
    const brickId = new mongoose.Types.ObjectId();
    const t = {
      _id: brickId,
      kind: TERRITORY_KIND.BRICK,
      materializedPath: `/${zoneId}/${areaId}/${brickId}/`
    };
    assert.deepEqual(areaZoneFromTerritory(t), {
      zoneId: String(zoneId),
      areaId: String(areaId)
    });
  });

  test('areaZoneFromTerritory — area and zone', () => {
    const zoneId = new mongoose.Types.ObjectId();
    const areaId = new mongoose.Types.ObjectId();
    assert.deepEqual(
      areaZoneFromTerritory({
        _id: areaId,
        kind: TERRITORY_KIND.AREA,
        materializedPath: `/${zoneId}/${areaId}/`
      }),
      { zoneId: String(zoneId), areaId: String(areaId) }
    );
    assert.deepEqual(
      areaZoneFromTerritory({
        _id: zoneId,
        kind: TERRITORY_KIND.ZONE,
        materializedPath: `/${zoneId}/`
      }),
      { zoneId: String(zoneId), areaId: null }
    );
  });

  test('buildOpenByDeliveryFromLedgerLines — allocated credit reduces delivery', () => {
    const d1 = new mongoose.Types.ObjectId();
    const d2 = new mongoose.Types.ObjectId();
    const open = buildOpenByDeliveryFromLedgerLines(
      [
        { referenceId: d1, amount: 100 },
        { referenceId: d2, amount: 50 }
      ],
      [{ amount: 30, meta: { deliveryId: d1 } }]
    );
    assert.equal(open[String(d1)], 70);
    assert.equal(open[String(d2)], 50);
  });

  test('buildOpenByDeliveryFromLedgerLines — unallocated FIFO by id', () => {
    const d1 = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
    const d2 = new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
    const open = buildOpenByDeliveryFromLedgerLines(
      [
        { referenceId: d1, amount: 40 },
        { referenceId: d2, amount: 60 }
      ],
      [{ amount: 50, meta: {} }]
    );
    assert.equal(open[String(d1)], 0);
    assert.equal(open[String(d2)], 50);
  });

  test('aggregateRows — pharmacy groups multi-MR portions separately then sums pharmacy', () => {
    const pharmacyId = new mongoose.Types.ObjectId();
    const repA = new mongoose.Types.ObjectId();
    const repB = new mongoose.Types.ObjectId();
    const rows = [
      {
        deliveryId: new mongoose.Types.ObjectId(),
        pharmacyId,
        medicalRepId: repA,
        pharmacyName: 'P1',
        medicalRepName: 'A',
        open: 100,
        areaId: null,
        zoneId: null
      },
      {
        deliveryId: new mongoose.Types.ObjectId(),
        pharmacyId,
        medicalRepId: repB,
        pharmacyName: 'P1',
        medicalRepName: 'B',
        open: 40,
        areaId: null,
        zoneId: null
      }
    ];
    const byPharmacy = aggregateRows(rows, GROUP_BY.pharmacy);
    assert.equal(byPharmacy.length, 1);
    assert.equal(byPharmacy[0].outstanding, 140);
    assert.equal(byPharmacy[0].invoiceCount, 2);
    assert.equal(byPharmacy[0].medicalRepCount, 2);

    const byRep = aggregateRows(rows, GROUP_BY.medicalRep);
    assert.equal(byRep.length, 2);
    const amounts = byRep.map((r) => r.outstanding).sort((a, b) => a - b);
    assert.deepEqual(amounts, [40, 100]);
  });

  test('aggregateRows — area and zone', () => {
    const areaId = String(new mongoose.Types.ObjectId());
    const zoneId = String(new mongoose.Types.ObjectId());
    const rows = [
      {
        deliveryId: new mongoose.Types.ObjectId(),
        pharmacyId: new mongoose.Types.ObjectId(),
        medicalRepId: new mongoose.Types.ObjectId(),
        pharmacyName: 'P',
        medicalRepName: 'R',
        open: 25,
        areaId,
        zoneId,
        areaName: 'North',
        zoneName: 'Quetta'
      }
    ];
    const byArea = aggregateRows(rows, GROUP_BY.area);
    assert.equal(byArea[0].key, areaId);
    assert.equal(byArea[0].label, 'North');
    assert.equal(byArea[0].outstanding, 25);

    const byZone = aggregateRows(rows, GROUP_BY.zone);
    assert.equal(byZone[0].key, zoneId);
    assert.equal(byZone[0].label, 'Quetta');
  });

  test('buildOpenByDeliveryFromLedgerLines — RETURN without deliveryId uses order targets', () => {
    const dOther = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
    const dReturned = new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
    const returnId = new mongoose.Types.ObjectId();
    const { LEDGER_REFERENCE_TYPE } = require('../constants/enums');
    const open = buildOpenByDeliveryFromLedgerLines(
      [
        { referenceId: dOther, amount: 100 },
        { referenceId: dReturned, amount: 80 }
      ],
      [
        {
          referenceId: returnId,
          amount: 80,
          referenceType: LEDGER_REFERENCE_TYPE.RETURN,
          meta: {}
        }
      ],
      {
        returnTargetsByReferenceId: new Map([[String(returnId), [String(dReturned)]]])
      }
    );
    // Return must clear the returned delivery, not the older unrelated invoice.
    assert.equal(open[String(dReturned)], 0);
    assert.equal(open[String(dOther)], 100);
  });

  test('buildOpenByDeliveryFromLedgerLines — RETURN meta.deliveryId still wins', () => {
    const d1 = new mongoose.Types.ObjectId();
    const d2 = new mongoose.Types.ObjectId();
    const { LEDGER_REFERENCE_TYPE } = require('../constants/enums');
    const open = buildOpenByDeliveryFromLedgerLines(
      [
        { referenceId: d1, amount: 50 },
        { referenceId: d2, amount: 50 }
      ],
      [
        {
          referenceId: new mongoose.Types.ObjectId(),
          amount: 50,
          referenceType: LEDGER_REFERENCE_TYPE.RETURN,
          meta: { deliveryId: d2 }
        }
      ]
    );
    assert.equal(open[String(d1)], 50);
    assert.equal(open[String(d2)], 0);
  });
});
