/**
 * Dashboard-aligned net TP Sales (Σ delivery TP×physical packs − return TP − amendment TP).
 * Fully qty-credited orders (returns + amendments cover all delivered packs) are excluded.
 */
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const OrderAmendment = require('../models/OrderAmendment');
const { ORDER_STATUS } = require('../constants/enums');
const { roundPKR } = require('../utils/currency');
const { isOrderFullyQtyCredited } = require('../utils/orderQty.util');

const nd = { $ne: true };

/**
 * Gross Sales (TP) for one delivery line: TP × physical packs (paid + bonus).
 */
const grossTpForDeliveryLine = (orderItem, deliveryLine) => {
  const physicalQty = Number(deliveryLine?.quantity) || 0;
  if (physicalQty <= 0) return 0;

  const tp = Number(orderItem?.tpAtTime);
  if (Number.isFinite(tp) && tp >= 0) {
    return roundPKR(tp * physicalQty);
  }

  const paidQty = deliveryLine.paidQuantity ?? physicalQty;
  const tpLineTotal = Number(deliveryLine.tpLineTotal) || 0;
  if (paidQty > 0 && tpLineTotal > 0) {
    return roundPKR((tpLineTotal / paidQty) * physicalQty);
  }
  return roundPKR(tpLineTotal);
};

const grossTpForDelivery = (delivery, order) => {
  let total = 0;
  for (const line of delivery.items || []) {
    const oi = order?.items?.find((i) => String(i.productId) === String(line.productId));
    total += grossTpForDeliveryLine(oi, line);
  }
  return roundPKR(total);
};

const isOrderFullyCredited = (order) => {
  if (!order) return false;
  if (order.status === ORDER_STATUS.RETURNED) return true;
  return isOrderFullyQtyCredited(order);
};

const sumReturnTp = (ret, order) => {
  let debit = 0;
  for (const ri of ret.items || []) {
    const oi = order.items.find((i) => String(i.productId) === String(ri.productId));
    if (oi) debit += roundPKR(Number(oi.tpAtTime) * Number(ri.quantity));
  }
  return roundPKR(debit);
};

const sumAmendmentTp = (amd, order) => {
  if (amd.tpDeltaTotal != null) return roundPKR(amd.tpDeltaTotal);
  let debit = 0;
  for (const ai of amd.items || []) {
    const oi = order.items.find((i) => String(i.productId) === String(ai.productId));
    if (oi) debit += roundPKR(Number(oi.tpAtTime) * Number(ai.deltaQty || 0));
    else if (ai.tpDelta != null) debit += roundPKR(ai.tpDelta);
  }
  return roundPKR(debit);
};

/**
 * @param {import('mongoose').Types.ObjectId} cid
 * @param {{ $gte: Date, $lte: Date } | null} dateRange
 * @param {import('mongoose').Types.ObjectId | null} medicalRepOid
 */
const computeDashboardNetGrossSalesTp = async (cid, dateRange, medicalRepOid = null) => {
  const deliveryFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) deliveryFilter.deliveredAt = dateRange;

  const returnFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) returnFilter.returnedAt = dateRange;

  const amendmentFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) amendmentFilter.amendedAt = dateRange;

  const repIdStr = medicalRepOid ? String(medicalRepOid) : null;
  const orderSelect = 'items status medicalRepId';

  const [deliveries, returns, amendments] = await Promise.all([
    DeliveryRecord.find(deliveryFilter).populate({ path: 'orderId', select: orderSelect }).lean(),
    ReturnRecord.find(returnFilter).populate({ path: 'orderId', select: orderSelect }).lean(),
    OrderAmendment.find(amendmentFilter).populate({ path: 'orderId', select: orderSelect }).lean()
  ]);

  let deliveredTp = 0;
  for (const d of deliveries) {
    const order = d.orderId;
    if (!order) continue;
    if (repIdStr && String(order.medicalRepId) !== repIdStr) continue;
    if (isOrderFullyCredited(order)) continue;
    deliveredTp += grossTpForDelivery(d, order);
  }
  deliveredTp = roundPKR(deliveredTp);

  let returnedTp = 0;
  for (const ret of returns) {
    const order = ret.orderId;
    if (!order) continue;
    if (repIdStr && String(order.medicalRepId) !== repIdStr) continue;
    if (isOrderFullyCredited(order)) continue;
    returnedTp += sumReturnTp(ret, order);
  }
  returnedTp = roundPKR(returnedTp);

  let amendedTp = 0;
  for (const amd of amendments) {
    const order = amd.orderId;
    if (!order) continue;
    if (repIdStr && String(order.medicalRepId) !== repIdStr) continue;
    if (isOrderFullyCredited(order)) continue;
    amendedTp += sumAmendmentTp(amd, order);
  }
  amendedTp = roundPKR(amendedTp);

  return roundPKR(deliveredTp - returnedTp - amendedTp);
};

/**
 * Net gross TP per medical rep in one fetch.
 */
const computeDashboardNetGrossSalesTpByReps = async (cid, dateRange, medicalRepOids = []) => {
  const repSet = new Set(medicalRepOids.map((id) => String(id)));
  const totals = new Map();
  for (const id of repSet) totals.set(id, 0);
  if (!repSet.size) return totals;

  const deliveryFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) deliveryFilter.deliveredAt = dateRange;

  const returnFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) returnFilter.returnedAt = dateRange;

  const amendmentFilter = { companyId: cid, isDeleted: nd };
  if (dateRange) amendmentFilter.amendedAt = dateRange;

  const orderSelect = 'items status medicalRepId';

  const [deliveries, returns, amendments] = await Promise.all([
    DeliveryRecord.find(deliveryFilter).populate({ path: 'orderId', select: orderSelect }).lean(),
    ReturnRecord.find(returnFilter).populate({ path: 'orderId', select: orderSelect }).lean(),
    OrderAmendment.find(amendmentFilter).populate({ path: 'orderId', select: orderSelect }).lean()
  ]);

  for (const d of deliveries) {
    const order = d.orderId;
    if (!order?.medicalRepId) continue;
    const repId = String(order.medicalRepId);
    if (!repSet.has(repId)) continue;
    if (isOrderFullyCredited(order)) continue;
    totals.set(repId, roundPKR((totals.get(repId) || 0) + grossTpForDelivery(d, order)));
  }

  for (const ret of returns) {
    const order = ret.orderId;
    if (!order?.medicalRepId) continue;
    const repId = String(order.medicalRepId);
    if (!repSet.has(repId)) continue;
    if (isOrderFullyCredited(order)) continue;
    totals.set(repId, roundPKR((totals.get(repId) || 0) - sumReturnTp(ret, order)));
  }

  for (const amd of amendments) {
    const order = amd.orderId;
    if (!order?.medicalRepId) continue;
    const repId = String(order.medicalRepId);
    if (!repSet.has(repId)) continue;
    if (isOrderFullyCredited(order)) continue;
    totals.set(repId, roundPKR((totals.get(repId) || 0) - sumAmendmentTp(amd, order)));
  }

  return totals;
};

module.exports = {
  computeDashboardNetGrossSalesTp,
  computeDashboardNetGrossSalesTpByReps,
  grossTpForDelivery,
  grossTpForDeliveryLine,
  sumReturnTp,
  sumAmendmentTp,
  isOrderFullyCredited
};
