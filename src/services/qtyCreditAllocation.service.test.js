/**
 * Run: node --test src/services/qtyCreditAllocation.service.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  QTY_CREDIT_ALLOCATION_POLICY,
  allocatePhysicalDelta,
  remainingCompositionAfterPriors,
  planQtyCredit,
  resolveDeliveryPaidBonus
} = require('./qtyCreditAllocation.service');

const dLine55 = {
  quantity: 10,
  paidQuantity: 5,
  bonusQuantity: 5,
  linePharmacyNet: 500,
  companyShare: 400,
  distributorShare: 100,
  avgCostAtTime: 40,
  finalSellingPrice: 50
};

describe('qtyCreditAllocation — Bonus-First', () => {
  test('resolveDeliveryPaidBonus from snapshot', () => {
    assert.deepEqual(resolveDeliveryPaidBonus(dLine55), {
      physical: 10,
      paidDelivered: 5,
      bonusDelivered: 5
    });
  });

  test('5+5 amend by 2 → bonus only, zero AR credit', () => {
    const plan = planQtyCredit({ dLine: dLine55, physicalDelta: 2 });
    assert.equal(plan.paidDelta, 0);
    assert.equal(plan.bonusDelta, 2);
    assert.equal(plan.creditAmount, 0);
    assert.equal(plan.lineCost, 80);
    assert.equal(plan.companyShare, 0);
    assert.equal(plan.physicalDelta, 2);
  });

  test('5+5 amend by 7 → bonus 5 then paid 2, credit 200', () => {
    const plan = planQtyCredit({ dLine: dLine55, physicalDelta: 7 });
    assert.equal(plan.bonusDelta, 5);
    assert.equal(plan.paidDelta, 2);
    assert.equal(plan.creditAmount, 200);
    assert.equal(plan.paidUnitNet, 100);
    assert.equal(plan.companyShare, 160);
    assert.equal(plan.distributorShare, 40);
    assert.equal(plan.lineCost, 280);
  });

  test('no bonus: paid-only line credits paid unit net', () => {
    const dLine = {
      quantity: 10,
      paidQuantity: 10,
      bonusQuantity: 0,
      linePharmacyNet: 1000,
      companyShare: 1000,
      distributorShare: 0,
      avgCostAtTime: 30
    };
    const plan = planQtyCredit({ dLine, physicalDelta: 2 });
    assert.equal(plan.paidDelta, 2);
    assert.equal(plan.bonusDelta, 0);
    assert.equal(plan.creditAmount, 200);
  });

  test('second credit after prior bonus-first uses residual paid', () => {
    const afterFirst = remainingCompositionAfterPriors(dLine55, [
      { physicalQty: 2, paidDelta: 0, bonusDelta: 2 }
    ]);
    assert.equal(afterFirst.remainingBonus, 3);
    assert.equal(afterFirst.remainingPaid, 5);

    const plan = planQtyCredit({
      dLine: dLine55,
      physicalDelta: 4,
      priorCredits: [{ physicalQty: 2, paidDelta: 0, bonusDelta: 2 }]
    });
    assert.equal(plan.bonusDelta, 3);
    assert.equal(plan.paidDelta, 1);
    assert.equal(plan.creditAmount, 100);
  });

  test('legacy prior physical (no split) interpreted bonus-first for pool', () => {
    const plan = planQtyCredit({
      dLine: dLine55,
      physicalDelta: 1,
      priorCredits: [{ physicalQty: 5 }] // legacy blended row
    });
    // Prior 5 consumed all bonus → remaining paid 5, bonus 0 → next 1 is paid
    assert.equal(plan.bonusDelta, 0);
    assert.equal(plan.paidDelta, 1);
    assert.equal(plan.creditAmount, 100);
  });

  test('Paid-First stub available for future policy switch', () => {
    const split = allocatePhysicalDelta(
      QTY_CREDIT_ALLOCATION_POLICY.PAID_FIRST,
      2,
      5,
      5
    );
    assert.equal(split.paidDelta, 2);
    assert.equal(split.bonusDelta, 0);
  });

  test('Proportional stub preserves ratio on remaining pool', () => {
    const split = allocatePhysicalDelta(
      QTY_CREDIT_ALLOCATION_POLICY.PROPORTIONAL,
      2,
      5,
      5
    );
    assert.equal(split.paidDelta + split.bonusDelta, 2);
    assert.equal(split.paidDelta, 1);
    assert.equal(split.bonusDelta, 1);
  });

  test('rejects over-credit beyond remaining composition', () => {
    assert.throws(() =>
      planQtyCredit({
        dLine: dLine55,
        physicalDelta: 3,
        priorCredits: [{ physicalQty: 10, paidDelta: 5, bonusDelta: 5 }]
      })
    );
  });
});
