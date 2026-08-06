const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { finalizeMovement, emptyMovement } = require('./tpSalesMovement.service');
const { classifySourceDeliveryPeriod } = require('../utils/sourceDeliverySnapshot.util');

describe('tpSalesMovement finalizeMovement identity', () => {
  it('Net TP Sales = Gross − returns − amendments (all buckets)', () => {
    const m = finalizeMovement({
      grossDeliveriesTp: 1000,
      returnsCurrentPeriodTp: 100,
      returnsPriorPeriodTp: 200,
      amendmentsCurrentPeriodTp: 50,
      amendmentsPriorPeriodTp: 25,
      returnsUnclassifiedTp: 10,
      amendmentsUnclassifiedTp: 5
    });
    assert.equal(m.netTpSales, 610);
  });

  it('prior-period return reduces event-month Net TP Sales (Dashboard-aligned identity)', () => {
    // Partial prior-period return on a non-fully-credited order (same rules as Dashboard Gross TP).
    const june = finalizeMovement({
      ...emptyMovement(),
      grossDeliveriesTp: 568701
    });
    const july = finalizeMovement({
      ...emptyMovement(),
      returnsPriorPeriodTp: 439110
    });
    assert.equal(june.netTpSales, 568701);
    assert.equal(july.netTpSales, -439110);
    assert.equal(classifySourceDeliveryPeriod('2026-07', '2026-06'), 'priorPeriod');
  });

  it('identity equals Dashboard formula components (D − R − A)', () => {
    const m = finalizeMovement({
      grossDeliveriesTp: 1000,
      returnsCurrentPeriodTp: 100,
      returnsPriorPeriodTp: 50,
      amendmentsCurrentPeriodTp: 25,
      amendmentsPriorPeriodTp: 25,
      returnsUnclassifiedTp: 0,
      amendmentsUnclassifiedTp: 0
    });
    assert.equal(m.netTpSales, 800);
  });

  it('empty movement nets to zero', () => {
    assert.equal(finalizeMovement(emptyMovement()).netTpSales, 0);
  });
});
