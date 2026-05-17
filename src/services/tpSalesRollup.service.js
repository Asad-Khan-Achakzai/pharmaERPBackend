/**
 * Dashboard-aligned net TP Sales (Σ delivery tpSubtotal − return TP reversal) scoped by deliveredAt / returnedAt.
 * Mirrors `computeNetTpAchieved` semantics: fully returned orders excluded from delivery credit and return debit.
 */
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const { ORDER_STATUS } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');

const nd = { $ne: true };

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
    deliveredTp += roundPKR(d.tpSubtotal || 0);
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

module.exports = { computeDashboardNetGrossSalesTp };
