/**
 * Shared order-line quantity rules for returns and amendments.
 * remainingAmendableQty === remainingReturnableQty (shared pool).
 */

const n = (v) => Math.max(0, Number(v) || 0);

/** Remaining physical packs that can still be returned or amended down. */
const remainingAmendableQty = (item) => {
  const delivered = n(item?.deliveredQty);
  const returned = n(item?.returnedQty);
  const amended = n(item?.amendedQty);
  return Math.max(0, delivered - returned - amended);
};

/** Alias — returns and amendments share the same remaining pool. */
const remainingReturnableQty = remainingAmendableQty;

/** Net packs still economically/physically outstanding after returns + amendments. */
const effectiveDeliveredQty = remainingAmendableQty;

/**
 * True when every delivered pack has been fully credited via return and/or amendment.
 * Used by TP rollups (exclude fully credited orders from delivery credit and debit).
 */
const isOrderFullyQtyCredited = (order) => {
  if (!order?.items?.length) return false;
  return order.items.every((i) => n(i.returnedQty) + n(i.amendedQty) >= n(i.deliveredQty));
};

/**
 * @param {number} newQty desired remaining effective qty
 * @param {number} remaining current remainingAmendableQty
 * @returns {number} positive delta packs to credit
 */
const deltaQtyForNewRemaining = (newQty, remaining) => {
  const next = Number(newQty);
  const rem = n(remaining);
  if (!Number.isFinite(next) || next < 0 || !Number.isInteger(next)) {
    throw new Error('newQuantity must be a non-negative integer');
  }
  if (next > rem) {
    throw new Error(`newQuantity ${next} exceeds remaining ${rem}`);
  }
  const delta = rem - next;
  if (delta < 1) {
    throw new Error('Amendment must reduce quantity by at least 1');
  }
  return delta;
};

module.exports = {
  remainingAmendableQty,
  remainingReturnableQty,
  effectiveDeliveredQty,
  isOrderFullyQtyCredited,
  deltaQtyForNewRemaining
};
