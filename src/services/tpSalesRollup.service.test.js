const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { grossTpForDeliveryLine, grossTpForDelivery } = require('./tpSalesRollup.service');

describe('tpSalesRollup gross TP', () => {
  it('uses TP × physical qty when order line is present', () => {
    const orderItem = { tpAtTime: 100 };
    const line = { quantity: 12, paidQuantity: 10, bonusQuantity: 2, tpLineTotal: 1000 };
    assert.equal(grossTpForDeliveryLine(orderItem, line), 1200);
  });

  it('infers physical gross from paid slice on legacy rows', () => {
    const line = { quantity: 15, paidQuantity: 10, bonusQuantity: 5, tpLineTotal: 1000 };
    assert.equal(grossTpForDeliveryLine(null, line), 1500);
  });

  it('sums delivery lines by physical quantity', () => {
    const delivery = {
      items: [
        { productId: 'p1', quantity: 5, tpLineTotal: 500, paidQuantity: 5 },
        { productId: 'p2', quantity: 8, tpLineTotal: 600, paidQuantity: 6, bonusQuantity: 2 }
      ]
    };
    const order = {
      items: [
        { productId: 'p1', tpAtTime: 100 },
        { productId: 'p2', tpAtTime: 100 }
      ]
    };
    assert.equal(grossTpForDelivery(delivery, order), 1300);
  });
});
