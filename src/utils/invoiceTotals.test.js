/**
 * Run: node --test src/utils/invoiceTotals.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveInvoiceGrandTotal, resolveGoodsNetPayable, resolveTaxTotal } = require('./invoiceTotals');

describe('invoiceTotals', () => {
  test('legacy delivery falls back to pharmacyNetPayable', () => {
    const d = { pharmacyNetPayable: 1000, totalAmount: 1000 };
    assert.equal(resolveInvoiceGrandTotal(d), 1000);
    assert.equal(resolveGoodsNetPayable(d), 1000);
    assert.equal(resolveTaxTotal(d), 0);
  });

  test('taxed delivery uses invoiceGrandTotal', () => {
    const d = {
      pharmacyNetPayable: 100000,
      goodsNetPayable: 100000,
      taxTotal: 500,
      invoiceGrandTotal: 100500
    };
    assert.equal(resolveInvoiceGrandTotal(d), 100500);
    assert.equal(resolveGoodsNetPayable(d), 100000);
    assert.equal(resolveTaxTotal(d), 500);
  });
});
