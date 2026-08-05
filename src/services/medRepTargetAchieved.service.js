const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const MedRepTarget = require('../models/MedRepTarget');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const OrderAmendment = require('../models/OrderAmendment');
const { requireCompanyIanaZone, coalesceBusinessDateRangeFromYmd } = require('../utils/businessTime');
const { computeDashboardNetGrossSalesTp } = require('./tpSalesRollup.service');

const toOid = (id) => new mongoose.Types.ObjectId(String(id));
const nd = { $ne: true };

/**
 * Net packs = deliveries − returns − amendments (no clamp; negatives allowed).
 * Shared by sync, breakdown, and repair so list progress matches the drawer.
 */
const netAchievedPacksFromTotals = ({ delivered = 0, returned = 0, amended = 0 } = {}) =>
  (Number(delivered) || 0) - (Number(returned) || 0) - (Number(amended) || 0);

/**
 * UTC range for a calendar month in company TZ (aligned with MRep month keys / dashboard).
 */
const monthCalendarUtcRange = (yyyyMm, tz) => {
  const zone = requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  const fromYmd = startLocal.toFormat('yyyy-MM-dd');
  const toYmd = endLocal.toFormat('yyyy-MM-dd');
  return coalesceBusinessDateRangeFromYmd(fromYmd, toYmd, zone);
};

const packQtyByProductPipeline = (companyId, dateField, range, medicalRepId, qtyField) => [
  { $match: { companyId, isDeleted: nd, [dateField]: range } },
  { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'ord' } },
  { $unwind: '$ord' },
  { $match: { 'ord.medicalRepId': medicalRepId, 'ord.isDeleted': nd } },
  { $unwind: '$items' },
  { $group: { _id: '$items.productId', qty: { $sum: `$items.${qtyField}` } } }
];

/**
 * Per-product pack events for a rep/month (company TZ calendar window).
 * @returns {{ deliveredByProduct: Map<string,number>, returnedByProduct: Map<string,number>, amendedByProduct: Map<string,number>, totals: { delivered: number, returned: number, amended: number, net: number } }}
 */
const aggregatePackEventsByProduct = async (companyId, repId, yyyyMm, tz) => {
  const range = monthCalendarUtcRange(yyyyMm, tz);
  const cid = toOid(companyId);
  const rid = toOid(repId);

  const [delAgg, retAgg, amdAgg] = await Promise.all([
    DeliveryRecord.aggregate(packQtyByProductPipeline(cid, 'deliveredAt', range, rid, 'quantity')),
    ReturnRecord.aggregate(packQtyByProductPipeline(cid, 'returnedAt', range, rid, 'quantity')),
    OrderAmendment.aggregate(packQtyByProductPipeline(cid, 'amendedAt', range, rid, 'deltaQty'))
  ]);

  const deliveredByProduct = new Map(delAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const returnedByProduct = new Map(retAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const amendedByProduct = new Map(amdAgg.map((x) => [String(x._id), Number(x.qty) || 0]));

  let delivered = 0;
  let returned = 0;
  let amended = 0;
  for (const q of deliveredByProduct.values()) delivered += q;
  for (const q of returnedByProduct.values()) returned += q;
  for (const q of amendedByProduct.values()) amended += q;

  return {
    deliveredByProduct,
    returnedByProduct,
    amendedByProduct,
    totals: {
      delivered,
      returned,
      amended,
      net: netAchievedPacksFromTotals({ delivered, returned, amended })
    }
  };
};

const computeAchievedTpForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const range = monthCalendarUtcRange(yyyyMm, tz);
  return computeDashboardNetGrossSalesTp(toOid(companyId), range, toOid(repId));
};

const syncAchievedSalesTpForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const achieved = await computeAchievedTpForRepMonth(companyId, repId, yyyyMm, tz);
  await MedRepTarget.updateOne(
    {
      companyId: toOid(companyId),
      medicalRepId: toOid(repId),
      month: yyyyMm,
      isDeleted: { $ne: true }
    },
    { $set: { achievedSales: achieved } }
  );
  return achieved;
};

const computeAchievedPacksForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const { totals } = await aggregatePackEventsByProduct(companyId, repId, yyyyMm, tz);
  return totals.net;
};

const syncAchievedPacksForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const achieved = await computeAchievedPacksForRepMonth(companyId, repId, yyyyMm, tz);
  await MedRepTarget.updateOne(
    {
      companyId: toOid(companyId),
      medicalRepId: toOid(repId),
      month: yyyyMm,
      isDeleted: { $ne: true }
    },
    { $set: { achievedPacks: achieved } }
  );
  return achieved;
};

/** Recompute both sales TP and packs for a rep/month (idempotent). */
const syncAchievedForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const [achievedSales, achievedPacks] = await Promise.all([
    syncAchievedSalesTpForRepMonth(companyId, repId, yyyyMm, tz),
    syncAchievedPacksForRepMonth(companyId, repId, yyyyMm, tz)
  ]);
  return { achievedSales, achievedPacks };
};

module.exports = {
  monthCalendarUtcRange,
  netAchievedPacksFromTotals,
  aggregatePackEventsByProduct,
  computeAchievedTpForRepMonth,
  syncAchievedSalesTpForRepMonth,
  computeAchievedPacksForRepMonth,
  syncAchievedPacksForRepMonth,
  syncAchievedForRepMonth
};
