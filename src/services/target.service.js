const mongoose = require('mongoose');
const MedRepTarget = require('../models/MedRepTarget');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const Product = require('../models/Product');
const logger = require('../utils/logger');
const medRepTargetAchievedService = require('./medRepTargetAchieved.service');
const businessTime = require('../utils/businessTime');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');

const nd = { $ne: true };

const TARGET_POPULATE = [
  { path: 'medicalRepId', select: 'name' },
  { path: 'productPacksTargets.productId', select: 'name composition' }
];

const normalizeProductPacksTargets = (rows) => {
  if (!Array.isArray(rows)) return [];
  const byProduct = new Map();
  for (const row of rows) {
    const pid = String(row?.productId || '').trim();
    const qty = Math.max(0, Math.floor(Number(row?.packsTarget) || 0));
    if (!pid || qty <= 0) continue;
    byProduct.set(pid, { productId: pid, packsTarget: qty });
  }
  return Array.from(byProduct.values());
};

const sumProductPacksTargets = (rows) => {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => sum + (Math.max(0, Math.floor(Number(row?.packsTarget) || 0))), 0);
};

const assertHasTarget = (salesTarget, packsTarget, productPacksTargets) => {
  const sales = Number(salesTarget) || 0;
  const packs = Number(packsTarget) || 0;
  const productSum = sumProductPacksTargets(productPacksTargets);
  if (sales > 0 || packs > 0 || productSum > 0) return;
  throw new ApiError(
    400,
    'At least one of sales target, whole packs target, or product pack targets must be greater than 0'
  );
};

/**
 * Net packs per product for the target month: sums delivery line quantities in the month
 * minus return line quantities in the month (same window as MedRepTarget.achievedPacks).
 * Merges saved per-product pack targets when a MedRepTarget row exists.
 */
const packsBreakdownByProduct = async (companyId, medicalRepId, yyyyMm, timeZone) => {
  businessTime.requireCompanyIanaZone(timeZone);
  const range = medRepTargetAchievedService.monthCalendarUtcRange(yyyyMm, timeZone);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(medicalRepId));

  const [delAgg, retAgg, targetDoc] = await Promise.all([
    DeliveryRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, deliveredAt: range } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'ord' } },
      { $unwind: '$ord' },
      { $match: { 'ord.medicalRepId': rid, 'ord.isDeleted': nd } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', qty: { $sum: '$items.quantity' } } }
    ]),
    ReturnRecord.aggregate([
      { $match: { companyId: cid, isDeleted: nd, returnedAt: range } },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'ord' } },
      { $unwind: '$ord' },
      { $match: { 'ord.medicalRepId': rid, 'ord.isDeleted': nd } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', qty: { $sum: '$items.quantity' } } }
    ]),
    MedRepTarget.findOne({ companyId: cid, medicalRepId: rid, month: yyyyMm, isDeleted: nd })
      .populate('productPacksTargets.productId', 'name composition')
      .lean()
  ]);

  const deliveredByProduct = new Map(delAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const returnedByProduct = new Map(retAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const targetByProduct = new Map();
  for (const pt of targetDoc?.productPacksTargets || []) {
    const pid = String(pt.productId?._id || pt.productId || '');
    if (!pid) continue;
    targetByProduct.set(pid, {
      packsTarget: Math.max(0, Math.floor(Number(pt.packsTarget) || 0)),
      productName: pt.productId?.name ? String(pt.productId.name) : '',
      composition: pt.productId?.composition ? String(pt.productId.composition) : ''
    });
  }

  const allIds = new Set([
    ...deliveredByProduct.keys(),
    ...returnedByProduct.keys(),
    ...targetByProduct.keys()
  ]);

  const rows = [];
  let totalNet = 0;
  for (const sid of allIds) {
    const delivered = deliveredByProduct.get(sid) || 0;
    const returned = returnedByProduct.get(sid) || 0;
    const net = delivered - returned;
    totalNet += net;
    const targetMeta = targetByProduct.get(sid);
    const packsTarget = targetMeta?.packsTarget ?? 0;
    rows.push({
      productId: sid,
      deliveredQuantity: delivered,
      returnedQuantity: returned,
      netQuantity: net,
      packsTarget,
      progressPercent: packsTarget > 0 ? Math.min(100, (net / packsTarget) * 100) : null
    });
  }

  if (rows.length > 0) {
    const missingNameIds = rows
      .filter((r) => !targetByProduct.has(r.productId))
      .map((r) => new mongoose.Types.ObjectId(r.productId));
    const products =
      missingNameIds.length > 0
        ? await Product.find({ companyId: cid, _id: { $in: missingNameIds } })
            .select('name composition')
            .lean()
        : [];
    const nameById = new Map(products.map((p) => [String(p._id), p]));
    for (const r of rows) {
      const fromTarget = targetByProduct.get(r.productId);
      const p = fromTarget || nameById.get(r.productId);
      r.productName = fromTarget?.productName || p?.name || 'Unknown product';
      r.composition = fromTarget?.composition || (p?.composition ? String(p.composition) : '');
    }
    rows.sort(
      (a, b) =>
        (b.packsTarget || 0) - (a.packsTarget || 0) ||
        b.netQuantity - a.netQuantity ||
        String(a.productName).localeCompare(String(b.productName))
    );
  }

  return {
    month: yyyyMm,
    medicalRepId: String(rid),
    wholePacksTarget: Number(targetDoc?.packsTarget) || 0,
    totalNetPacks: totalNet,
    rows
  };
};

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.month) filter.month = query.month;
  if (searchTerm && !query.month) {
    const rx = escapeRegex(searchTerm);
    filter.month = { $regex: rx, $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    MedRepTarget.find(filter).populate(TARGET_POPULATE).sort(sort).skip(skip).limit(limit),
    MedRepTarget.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser, timeZone = 'UTC') => {
  const productPacksTargets = normalizeProductPacksTargets(data.productPacksTargets);
  assertHasTarget(data.salesTarget, data.packsTarget, productPacksTargets);
  const target = await MedRepTarget.create({
    ...data,
    productPacksTargets,
    companyId,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'target.create',
    entityType: 'MedRepTarget',
    entityId: target._id,
    changes: { after: target.toObject() }
  });
  try {
    await medRepTargetAchievedService.syncAchievedSalesTpForRepMonth(
      companyId,
      data.medicalRepId,
      data.month,
      timeZone
    );
  } catch (e) {
    logger.error('MedRepTarget TP sync failed after target create', {
      companyId: String(companyId),
      month: data.month,
      message: e?.message,
      stack: e?.stack
    });
  }
  const refreshed = await MedRepTarget.findById(target._id).populate(TARGET_POPULATE);
  return refreshed || target;
};

const update = async (companyId, id, data, reqUser) => {
  const target = await MedRepTarget.findOne({ _id: id, companyId });
  if (!target) throw new ApiError(404, 'Target not found');
  const before = target.toObject();
  if (data.salesTarget !== undefined) target.salesTarget = data.salesTarget;
  if (data.packsTarget !== undefined) target.packsTarget = data.packsTarget;
  if (data.productPacksTargets !== undefined) {
    target.productPacksTargets = normalizeProductPacksTargets(data.productPacksTargets);
  }
  assertHasTarget(target.salesTarget, target.packsTarget, target.productPacksTargets);
  target.updatedBy = reqUser.userId;
  await target.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'target.update',
    entityType: 'MedRepTarget',
    entityId: target._id,
    changes: { before, after: target.toObject() }
  });
  return MedRepTarget.findById(target._id).populate(TARGET_POPULATE);
};

const remove = async (companyId, id, reqUser) => {
  const target = await MedRepTarget.findOne({ _id: id, companyId });
  if (!target) throw new ApiError(404, 'Target not found');
  const before = target.toObject();
  await target.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'target.delete',
    entityType: 'MedRepTarget',
    entityId: target._id,
    changes: { before }
  });
};

const getByRep = async (companyId, repId) => {
  return MedRepTarget.find({ companyId, medicalRepId: repId })
    .populate(TARGET_POPULATE)
    .sort({ month: -1 });
};

module.exports = { list, create, update, remove, getByRep, packsBreakdownByProduct };
