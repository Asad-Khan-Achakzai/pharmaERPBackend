const { roundPKR } = require('./currency');

/**
 * Resolve the amount the pharmacy owes for a delivery/invoice.
 * Forward-compatible: historical docs without tax use goods net.
 *
 * @param {object} delivery - DeliveryRecord-like object
 * @returns {number}
 */
const resolveInvoiceGrandTotal = (delivery) => {
  if (!delivery) return 0;
  if (delivery.invoiceGrandTotal != null && Number.isFinite(Number(delivery.invoiceGrandTotal))) {
    return roundPKR(Number(delivery.invoiceGrandTotal));
  }
  const goods = delivery.pharmacyNetPayable ?? delivery.totalAmount ?? delivery.invoiceAmount ?? 0;
  return roundPKR(Number(goods) || 0);
};

/**
 * Goods-only net (revenue / share basis). Never includes tax.
 *
 * @param {object} delivery
 * @returns {number}
 */
const resolveGoodsNetPayable = (delivery) => {
  if (!delivery) return 0;
  if (delivery.goodsNetPayable != null && Number.isFinite(Number(delivery.goodsNetPayable))) {
    return roundPKR(Number(delivery.goodsNetPayable));
  }
  return roundPKR(Number(delivery.pharmacyNetPayable ?? delivery.totalAmount ?? 0) || 0);
};

/**
 * Tax total on a delivery (0 for legacy / disabled).
 *
 * @param {object} delivery
 * @returns {number}
 */
const resolveTaxTotal = (delivery) => {
  if (!delivery) return 0;
  if (delivery.taxTotal != null && Number.isFinite(Number(delivery.taxTotal))) {
    return roundPKR(Number(delivery.taxTotal));
  }
  const snap = delivery.taxSnapshot?.amounts?.taxTotal;
  if (snap != null && Number.isFinite(Number(snap))) return roundPKR(Number(snap));
  return 0;
};

module.exports = {
  resolveInvoiceGrandTotal,
  resolveGoodsNetPayable,
  resolveTaxTotal
};
