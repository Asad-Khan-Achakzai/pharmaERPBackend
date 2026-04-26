const mongoose = require('mongoose');
const DoctorActivity = require('../models/DoctorActivity');
const Doctor = require('../models/Doctor');
const User = require('../models/User');
const DeliveryRecord = require('../models/DeliveryRecord');
const ReturnRecord = require('../models/ReturnRecord');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { roundPKR } = require('../utils/currency');
const { DOCTOR_ACTIVITY_STATUS, ORDER_STATUS } = require('../constants/enums');
const auditService = require('./audit.service');

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

/** Delivery / return timestamp falls within activity window (inclusive calendar days). */
const isInstantInActivityRange = (instant, activityStart, activityEnd) => {
  const t = new Date(instant).getTime();
  return t >= startOfDay(activityStart).getTime() && t <= endOfDay(activityEnd).getTime();
};

const deriveStatus = (activity) => {
  const achieved = roundPKR(activity.achievedSales);
  const commitment = roundPKR(activity.commitmentAmount);
  if (achieved >= commitment) return DOCTOR_ACTIVITY_STATUS.COMPLETED;
  const now = new Date();
  if (endOfDay(activity.endDate).getTime() < startOfDay(now).getTime() && achieved < commitment) {
    return DOCTOR_ACTIVITY_STATUS.FAILED;
  }
  return DOCTOR_ACTIVITY_STATUS.ACTIVE;
};

const applyStatus = (activity) => {
  activity.status = deriveStatus(activity);
};

/** Mark ACTIVE rows past end date as COMPLETED or FAILED (no cron required). */
const finalizeExpiredActivities = async (companyId) => {
  const todayStart = startOfDay(new Date());
  const stale = await DoctorActivity.find({
    companyId,
    status: DOCTOR_ACTIVITY_STATUS.ACTIVE,
    endDate: { $lt: todayStart }
  });
  for (const a of stale) {
    applyStatus(a);
    await a.save();
  }
};

/**
 * Matches order return processing: all lines have returned all delivered units (see order.service).
 * Fully returned orders are excluded from doctor-activity net (treated as if they had no effect).
 */
const isOrderFullyReturned = (order) => {
  if (!order) return false;
  if (order.status === ORDER_STATUS.RETURNED) return true;
  if (!order.items?.length) return false;
  return order.items.every((i) => (i.returnedQty || 0) >= (i.deliveredQty || 0));
};

const logFullyReturnedSkip = (order, seenOrderIds) => {
  if (process.env.DEBUG_DOCTOR_ACTIVITY !== '1' || !order) return;
  const id = String(order._id);
  if (seenOrderIds?.has(id)) return;
  seenOrderIds?.add(id);
  const items = order.items || [];
  const deliveredQty = items.reduce((s, i) => s + (i.deliveredQty || 0), 0);
  const returnedQty = items.reduce((s, i) => s + (i.returnedQty || 0), 0);
  // eslint-disable-next-line no-console
  console.log({ orderId: id, deliveredQty, returnedQty, isFullyReturned: true });
};

/**
 * Net TP (PKR) for a doctor in [startDate, endDate]:
 * - Fully returned orders: excluded (no delivery credit, no return debit for activity).
 * - Otherwise: sum delivery tpSubtotal in range minus returned TP in range (unchanged net semantics for partial returns).
 */
const computeNetTpAchieved = async (companyId, doctorId, startDate, endDate) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const did = new mongoose.Types.ObjectId(doctorId);
  const start = startOfDay(startDate);
  const end = endOfDay(endDate);
  const debugSkipTp = new Set();

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    deliveredAt: { $gte: start, $lte: end },
    isDeleted: { $ne: true }
  })
    .populate({ path: 'orderId', select: 'doctorId items status' })
    .lean();

  let deliveredTp = 0;
  for (const d of deliveries) {
    const order = d.orderId;
    if (!order || order.doctorId?.toString() !== did.toString()) continue;
    if (isOrderFullyReturned(order)) {
      logFullyReturnedSkip(order, debugSkipTp);
      continue;
    }
    deliveredTp += roundPKR(d.tpSubtotal || 0);
  }
  deliveredTp = roundPKR(deliveredTp);

  const returns = await ReturnRecord.find({
    companyId: cid,
    returnedAt: { $gte: start, $lte: end },
    isDeleted: { $ne: true }
  })
    .populate({ path: 'orderId', select: 'doctorId items status' })
    .lean();

  const debugSkipRetTp = new Set();
  let returnedTp = 0;
  for (const ret of returns) {
    const order = ret.orderId;
    if (!order || order.doctorId?.toString() !== did.toString()) continue;
    if (isOrderFullyReturned(order)) {
      logFullyReturnedSkip(order, debugSkipRetTp);
      continue;
    }
    for (const ri of ret.items || []) {
      const oi = order.items.find((i) => i.productId.toString() === ri.productId.toString());
      if (oi) returnedTp += roundPKR(oi.tpAtTime * ri.quantity);
    }
  }
  returnedTp = roundPKR(returnedTp);
  return roundPKR(deliveredTp - returnedTp);
};

/**
 * Net casting (company purchase / cost basis) for delivered qty minus returns — same scope as TP achieved.
 * Uses order line castingAtTime × quantity (snapshot at order time).
 */
const computeNetCastingAchieved = async (companyId, doctorId, startDate, endDate) => {
  const cid = new mongoose.Types.ObjectId(companyId);
  const did = new mongoose.Types.ObjectId(doctorId);
  const start = startOfDay(startDate);
  const end = endOfDay(endDate);
  const debugSkipCastD = new Set();

  const deliveries = await DeliveryRecord.find({
    companyId: cid,
    deliveredAt: { $gte: start, $lte: end },
    isDeleted: { $ne: true }
  })
    .populate({ path: 'orderId', select: 'doctorId items status' })
    .lean();

  let deliveredCasting = 0;
  for (const d of deliveries) {
    const order = d.orderId;
    if (!order || order.doctorId?.toString() !== did.toString()) continue;
    if (isOrderFullyReturned(order)) {
      logFullyReturnedSkip(order, debugSkipCastD);
      continue;
    }
    for (const line of d.items || []) {
      const oi = order.items.find((i) => i.productId.toString() === line.productId.toString());
      if (oi && oi.castingAtTime != null) {
        deliveredCasting += roundPKR(oi.castingAtTime * line.quantity);
      }
    }
  }
  deliveredCasting = roundPKR(deliveredCasting);

  const returns = await ReturnRecord.find({
    companyId: cid,
    returnedAt: { $gte: start, $lte: end },
    isDeleted: { $ne: true }
  })
    .populate({ path: 'orderId', select: 'doctorId items status' })
    .lean();

  const debugSkipCastR = new Set();
  let returnedCasting = 0;
  for (const ret of returns) {
    const order = ret.orderId;
    if (!order || order.doctorId?.toString() !== did.toString()) continue;
    if (isOrderFullyReturned(order)) {
      logFullyReturnedSkip(order, debugSkipCastR);
      continue;
    }
    for (const ri of ret.items || []) {
      const oi = order.items.find((i) => i.productId.toString() === ri.productId.toString());
      if (oi && oi.castingAtTime != null) {
        returnedCasting += roundPKR(oi.castingAtTime * ri.quantity);
      }
    }
  }
  returnedCasting = roundPKR(returnedCasting);
  return roundPKR(deliveredCasting - returnedCasting);
};

/**
 * Increment achievedSales on ACTIVE activities for TP delivered (order delivery).
 * Uses delivery.tpSubtotal (sum of TP × qty for delivered lines).
 */
const applyDeliveryTp = async (session, companyId, { doctorId, tpAmount, deliveredAt }) => {
  if (!doctorId || !tpAmount || tpAmount <= 0) return;

  const activities = await DoctorActivity.find({
    companyId,
    doctorId,
    status: DOCTOR_ACTIVITY_STATUS.ACTIVE,
    startDate: { $lte: endOfDay(deliveredAt) },
    endDate: { $gte: startOfDay(deliveredAt) }
  }).session(session);

  for (const act of activities) {
    if (!isInstantInActivityRange(deliveredAt, act.startDate, act.endDate)) continue;
    act.achievedSales = roundPKR(act.achievedSales + tpAmount);
    applyStatus(act);
    await act.save({ session });
  }
};

/**
 * Decrement achievedSales for returned TP (any activity overlapping the return date).
 */
const applyReturnTp = async (session, companyId, { doctorId, tpAmount, returnedAt }) => {
  if (!doctorId || !tpAmount || tpAmount <= 0) return;

  const activities = await DoctorActivity.find({
    companyId,
    doctorId,
    startDate: { $lte: endOfDay(returnedAt) },
    endDate: { $gte: startOfDay(returnedAt) }
  }).session(session);

  for (const act of activities) {
    if (!isInstantInActivityRange(returnedAt, act.startDate, act.endDate)) continue;
    act.achievedSales = roundPKR(Math.max(0, act.achievedSales - tpAmount));
    applyStatus(act);
    await act.save({ session });
  }
};

const list = async (companyId, query) => {
  await finalizeExpiredActivities(companyId);
  const { page, limit, skip, sort } = parsePagination(query);
  const filter = { companyId };
  if (query.doctorId) filter.doctorId = query.doctorId;
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.status) filter.status = query.status;

  const [docs, total] = await Promise.all([
    DoctorActivity.find(filter)
      .populate('doctorId', 'name specialization')
      .populate('medicalRepId', 'name email')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    DoctorActivity.countDocuments(filter)
  ]);

  /** Same TP net as getById — list was showing stale DB achievedSales from incremental applyDelivery/applyReturn. */
  const achievedList = await Promise.all(
    docs.map((a) => computeNetTpAchieved(companyId, a.doctorId, a.startDate, a.endDate))
  );
  const docsWithComputed = docs.map((a, i) => ({
    ...a.toObject(),
    achievedSales: roundPKR(achievedList[i])
  }));

  return { docs: docsWithComputed, total, page, limit };
};

const getById = async (companyId, id) => {
  await finalizeExpiredActivities(companyId);
  const activity = await DoctorActivity.findOne({ _id: id, companyId })
    .populate('doctorId', 'name specialization phone')
    .populate('medicalRepId', 'name email');
  if (!activity) throw new ApiError(404, 'Doctor activity not found');

  const [achievedTp, achievedCasting] = await Promise.all([
    computeNetTpAchieved(companyId, activity.doctorId, activity.startDate, activity.endDate),
    computeNetCastingAchieved(companyId, activity.doctorId, activity.startDate, activity.endDate)
  ]);
  const achievedTpR = roundPKR(achievedTp);
  const achievedCastingR = roundPKR(achievedCasting);
  const invested = roundPKR(activity.investedAmount);
  const grossOnVolume = roundPKR(achievedTpR - achievedCastingR);
  const castingVsInvested = invested > 0 ? achievedCastingR / invested : null;

  return {
    ...activity.toObject(),
    /** Aligns with computeNetTpAchieved (not stale incremental achievedSales) */
    achievedSales: achievedTpR,
    metrics: {
      achievedTp: achievedTpR,
      achievedCasting: achievedCastingR,
      /** TP − casting on the same delivered/returned quantities */
      grossOnDeliveredVolume: grossOnVolume,
      /** Company cost of goods (casting) vs doctor investment — “actual” recovery basis */
      castingRecoveryVsInvestmentMultiple: castingVsInvested,
      castingRecoveryVsInvestmentPercent: castingVsInvested != null ? castingVsInvested * 100 : null
    }
  };
};

const create = async (companyId, data, reqUser) => {
  const doctor = await Doctor.findOne({ _id: data.doctorId, companyId, isActive: true });
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  let medicalRepId = null;
  if (data.medicalRepId) {
    const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
    if (!rep) throw new ApiError(404, 'Medical rep not found');
    medicalRepId = data.medicalRepId;
  }

  const startDate = new Date(data.startDate);
  const endDate = new Date(data.endDate);
  if (startDate >= endDate) throw new ApiError(400, 'startDate must be before endDate');

  const achievedSales = await computeNetTpAchieved(companyId, data.doctorId, startDate, endDate);

  const activity = await DoctorActivity.create({
    companyId,
    doctorId: data.doctorId,
    medicalRepId,
    investedAmount: roundPKR(data.investedAmount),
    commitmentAmount: roundPKR(data.commitmentAmount),
    achievedSales,
    startDate,
    endDate,
    status: DOCTOR_ACTIVITY_STATUS.ACTIVE,
    createdBy: reqUser.userId
  });
  applyStatus(activity);
  await activity.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctorActivity.create',
    entityType: 'DoctorActivity',
    entityId: activity._id,
    changes: { after: activity.toObject() }
  });
  return getById(companyId, activity._id);
};

const update = async (companyId, id, data, reqUser) => {
  const activity = await DoctorActivity.findOne({ _id: id, companyId });
  if (!activity) throw new ApiError(404, 'Doctor activity not found');
  const before = activity.toObject();

  if (data.medicalRepId !== undefined) {
    if (data.medicalRepId === null || data.medicalRepId === '') {
      activity.medicalRepId = null;
    } else {
      const rep = await User.findOne({ _id: data.medicalRepId, companyId, isActive: true });
      if (!rep) throw new ApiError(404, 'Medical rep not found');
      activity.medicalRepId = data.medicalRepId;
    }
  }
  if (data.investedAmount !== undefined) activity.investedAmount = roundPKR(data.investedAmount);
  if (data.commitmentAmount !== undefined) activity.commitmentAmount = roundPKR(data.commitmentAmount);

  let rangeChanged = false;
  if (data.startDate !== undefined) {
    activity.startDate = new Date(data.startDate);
    rangeChanged = true;
  }
  if (data.endDate !== undefined) {
    activity.endDate = new Date(data.endDate);
    rangeChanged = true;
  }
  if (activity.startDate >= activity.endDate) throw new ApiError(400, 'startDate must be before endDate');

  if (data.doctorId !== undefined) {
    const doctor = await Doctor.findOne({ _id: data.doctorId, companyId, isActive: true });
    if (!doctor) throw new ApiError(404, 'Doctor not found');
    activity.doctorId = data.doctorId;
    rangeChanged = true;
  }

  if (rangeChanged) {
    activity.achievedSales = await computeNetTpAchieved(
      companyId,
      activity.doctorId,
      activity.startDate,
      activity.endDate
    );
  }

  applyStatus(activity);
  activity.updatedBy = reqUser.userId;
  await activity.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctorActivity.update',
    entityType: 'DoctorActivity',
    entityId: activity._id,
    changes: { before, after: activity.toObject() }
  });
  return getById(companyId, id);
};

const recalculate = async (companyId, id, reqUser) => {
  const activity = await DoctorActivity.findOne({ _id: id, companyId });
  if (!activity) throw new ApiError(404, 'Doctor activity not found');
  const before = activity.toObject();

  activity.achievedSales = await computeNetTpAchieved(
    companyId,
    activity.doctorId,
    activity.startDate,
    activity.endDate
  );
  applyStatus(activity);
  activity.updatedBy = reqUser.userId;
  await activity.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctorActivity.recalculate',
    entityType: 'DoctorActivity',
    entityId: activity._id,
    changes: { before, after: activity.toObject() }
  });
  return getById(companyId, id);
};

const getByDoctor = async (companyId, doctorId) => {
  await finalizeExpiredActivities(companyId);
  const docs = await DoctorActivity.find({ companyId, doctorId })
    .populate('doctorId', 'name')
    .populate('medicalRepId', 'name')
    .sort({ startDate: -1 });
  const achievedList = await Promise.all(
    docs.map((a) => computeNetTpAchieved(companyId, a.doctorId, a.startDate, a.endDate))
  );
  return docs.map((a, i) => ({
    ...a.toObject(),
    achievedSales: roundPKR(achievedList[i])
  }));
};

module.exports = {
  list,
  create,
  getById,
  update,
  recalculate,
  getByDoctor,
  applyDeliveryTp,
  applyReturnTp,
  computeNetTpAchieved,
  computeNetCastingAchieved
};
