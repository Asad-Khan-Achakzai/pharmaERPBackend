/**
 * Dashboard-aligned net TP Sales (Σ delivery TP×physical packs − return TP reversal) scoped by deliveredAt / returnedAt.
 * Mirrors `computeNetTpAchieved` semantics: fully returned orders excluded from delivery credit and return debit.
 */
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const { ORDER_STATUS } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');

const nd = { $ne: true };

/**
 * Gross Sales (TP) for one delivery line: TP × physical packs (paid + bonus).
 * Pharmacy invoice / commission splits may still use paid qty only; this is the pack-based TP total.
 *
 * @param {{ tpAtTime?: number } | null | undefined} orderItem
 * @param {{ quantity?: number, tpLineTotal?: number, paidQuantity?: number }} deliveryLine
 */
const grossTpForDeliveryLine = (orderItem, deliveryLine) => {
  const physicalQty = Number(deliveryLine?.quantity) || 0;
  if (physicalQty <= 0) return 0;

  const tp = Number(orderItem?.tpAtTime);
  if (Number.isFinite(tp) && tp >= 0) {
    return roundPKR(tp * physicalQty);
  }

  // Legacy fallback when order line is missing: infer TP rate from the paid slice.
  const paidQty = deliveryLine.paidQuantity ?? physicalQty;
  const tpLineTotal = Number(deliveryLine.tpLineTotal) || 0;
  if (paidQty > 0 && tpLineTotal > 0) {
    return roundPKR((tpLineTotal / paidQty) * physicalQty);
  }
  return roundPKR(tpLineTotal);
};

/**
 * @param {{ items?: Array<{ productId: unknown, quantity?: number, tpLineTotal?: number, paidQuantity?: number }> }} delivery
 * @param {{ items?: Array<{ productId: unknown, tpAtTime?: number }> } | null | undefined} order
 */
const grossTpForDelivery = (delivery, order) => {
  let total = 0;
  for (const line of delivery.items || []) {
    const oi = order?.items?.find((i) => String(i.productId) === String(line.productId));
    total += grossTpForDeliveryLine(oi, line);
  }
  return roundPKR(total);
};

/**
 * @param {import('mongoose').Types.ObjectId} cid
 * @param {{ $gte: Date, $lte: Date } | null} dateRange deliveredAt / returnedAt
 * @param {import('mongoose').Types.ObjectId | null} medicalRepOid
 */
const computeDashboardNetGrossSalesTp = async (cid, dateRange, medicalRepOid = null) => {
  const deliveryFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) deliveryFilter.deliveredAt = dateRange;

  const returnFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) returnFilter.returnedAt = dateRange;

  const repIdStr = medicalRepOid ? String(medicalRepOid) : null;

  /** @param {any} order */
  const isOrderFullyReturned = (order) => {
    if (!order) return false;
    if (order.status === ORDER_STATUS.RETURNED) return true;
    if (!order.items?.length) return false;
    return order.items.every((i) => (i.returnedQty || 0) >= (i.deliveredQty || 0));
  };

  const [deliveries, returns] = await Promise.all([
    DeliveryRecord.find(deliveryFilter).populate({ path: 'orderId', select: 'items status medicalRepId' }).lean(),
    ReturnRecord.find(returnFilter).populate({ path: 'orderId', select: 'items status medicalRepId' }).lean()
  ]);

  let deliveredTp = 0;
  for (const d of deliveries) {
    const order = d.orderId;
    if (!order) continue;
    if (repIdStr && String(order.medicalRepId) !== repIdStr) continue;
    if (isOrderFullyReturned(order)) continue;
    deliveredTp += grossTpForDelivery(d, order);
  }
  deliveredTp = roundPKR(deliveredTp);

  let returnedTp = 0;
  for (const ret of returns) {
    const order = ret.orderId;
    if (!order) continue;
    if (repIdStr && String(order.medicalRepId) !== repIdStr) continue;
    if (isOrderFullyReturned(order)) continue;
    for (const ri of ret.items || []) {
      const oi = order.items.find((i) => String(i.productId) === String(ri.productId));
      if (oi) returnedTp += roundPKR(Number(oi.tpAtTime) * Number(ri.quantity));
    }
  }
  returnedTp = roundPKR(returnedTp);

  return roundPKR(deliveredTp - returnedTp);
};

module.exports = {
  computeDashboardNetGrossSalesTp,
  grossTpForDelivery,
  grossTpForDeliveryLine
};
