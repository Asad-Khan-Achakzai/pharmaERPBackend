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

/**
 * Net packs per product for the target month: sums delivery line quantities in the month
 * minus return line quantities in the month (same window as MedRepTarget.achievedPacks).
 */
const packsBreakdownByProduct = async (companyId, medicalRepId, yyyyMm, timeZone) => {
  businessTime.requireCompanyIanaZone(timeZone);
  const range = medRepTargetAchievedService.monthCalendarUtcRange(yyyyMm, timeZone);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(medicalRepId));

  const [delAgg, retAgg] = await Promise.all([
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
    ])
  ]);

  const deliveredByProduct = new Map(delAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const returnedByProduct = new Map(retAgg.map((x) => [String(x._id), Number(x.qty) || 0]));
  const allIds = new Set([...deliveredByProduct.keys(), ...returnedByProduct.keys()]);

  const rows = [];
  let totalNet = 0;
  for (const sid of allIds) {
    const delivered = deliveredByProduct.get(sid) || 0;
    const returned = returnedByProduct.get(sid) || 0;
    const net = delivered - returned;
    totalNet += net;
    rows.push({
      productId: sid,
      deliveredQuantity: delivered,
      returnedQuantity: returned,
      netQuantity: net
    });
  }

  if (rows.length > 0) {
    const pids = rows.map((r) => new mongoose.Types.ObjectId(r.productId));
    const products = await Product.find({ companyId: cid, _id: { $in: pids } })
      .select('name composition')
      .lean();
    const nameById = new Map(products.map((p) => [String(p._id), p]));
    for (const r of rows) {
      const p = nameById.get(r.productId);
      r.productName = p?.name || 'Unknown product';
      r.composition = p?.composition ? String(p.composition) : '';
    }
    rows.sort((a, b) => b.netQuantity - a.netQuantity || String(a.productName).localeCompare(String(b.productName)));
  }

  return {
    month: yyyyMm,
    medicalRepId: String(rid),
    totalNetPacks: totalNet,
    rows
  };
};

const list = async (companyId, query, timeZone = "UTC") => {
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
    MedRepTarget.find(filter).populate('medicalRepId', 'name').sort(sort).skip(skip).limit(limit),
    MedRepTarget.countDocuments(filter)
  ]);
  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser, timeZone = 'UTC') => {
  const target = await MedRepTarget.create({ ...data, companyId, createdBy: reqUser.userId });
  await auditService.log({ companyId, userId: reqUser.userId, action: 'target.create', entityType: 'MedRepTarget', entityId: target._id, changes: { after: target.toObject() } });
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
  const refreshed = await MedRepTarget.findById(target._id);
  return refreshed || target;
};

const update = async (companyId, id, data, reqUser) => {
  const target = await MedRepTarget.findOne({ _id: id, companyId });
  if (!target) throw new ApiError(404, 'Target not found');
  const before = target.toObject();
  if (data.salesTarget !== undefined) target.salesTarget = data.salesTarget;
  if (data.packsTarget !== undefined) target.packsTarget = data.packsTarget;
  const sales = Number(target.salesTarget) || 0;
  const packs = Number(target.packsTarget) || 0;
  if (sales <= 0 && packs <= 0) {
    throw new ApiError(400, 'At least one of sales target or packs target must be greater than 0');
  }
  target.updatedBy = reqUser.userId;
  await target.save();
  await auditService.log({ companyId, userId: reqUser.userId, action: 'target.update', entityType: 'MedRepTarget', entityId: target._id, changes: { before, after: target.toObject() } });
  return target;
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
  return MedRepTarget.find({ companyId, medicalRepId: repId }).sort({ month: -1 });
};

module.exports = { list, create, update, remove, getByRep, packsBreakdownByProduct };
