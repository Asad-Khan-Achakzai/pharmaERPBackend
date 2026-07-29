/**
 * Run: node --test src/utils/orderQty.util.test.js src/services/arDocumentOpen.service.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  remainingAmendableQty,
  remainingReturnableQty,
  isOrderFullyQtyCredited,
  deltaQtyForNewRemaining
} = require('./orderQty.util');

describe('orderQty.util', () => {
  test('remainingAmendableQty shared with returnable', () => {
    const item = { deliveredQty: 100, returnedQty: 20, amendedQty: 10 };
    assert.equal(remainingAmendableQty(item), 70);
    assert.equal(remainingReturnableQty(item), 70);
  });

  test('defaults missing amendedQty', () => {
    assert.equal(remainingAmendableQty({ deliveredQty: 50, returnedQty: 5 }), 45);
  });

  test('isOrderFullyQtyCredited with mix of return + amendment', () => {
    assert.equal(
      isOrderFullyQtyCredited({
        items: [
          { deliveredQty: 100, returnedQty: 40, amendedQty: 60 },
          { deliveredQty: 10, returnedQty: 10, amendedQty: 0 }
        ]
      }),
      true
    );
    assert.equal(
      isOrderFullyQtyCredited({
        items: [{ deliveredQty: 100, returnedQty: 0, amendedQty: 50 }]
      }),
      false
    );
  });

  test('deltaQtyForNewRemaining', () => {
    assert.equal(deltaQtyForNewRemaining(50, 100), 50);
    assert.throws(() => deltaQtyForNewRemaining(100, 100));
    assert.throws(() => deltaQtyForNewRemaining(101, 100));
  });
});
