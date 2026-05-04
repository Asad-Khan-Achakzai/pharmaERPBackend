const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const PlanItem = require('../models/PlanItem');
const WeeklyPlan = require('../models/WeeklyPlan');
const VisitLog = require('../models/VisitLog');
const Doctor = require('../models/Doctor');
const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const { PLAN_ITEM_TYPE, PLAN_ITEM_STATUS, WEEKLY_PLAN_STATUS, UNPLANNED_VISIT_REASON, DAY_EXECUTION_STATE } = require('../constants/enums');
const businessTime = require('../utils/businessTime');
const planExecution = require('../utils/planExecution.util');
const attendanceService = require('./attendance.service');
const auditService = require('./audit.service');
const env = require('../config/env');

const normalizePlanItemDate = (input, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return businessTime.businessDayStartUtc(input, tz);
  }
  const js = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(js.getTime())) throw new ApiError(400, 'Invalid plan item date');
  const ymd = businessTime.businessDayKeyFromUtcInstant(js, tz);
  return businessTime.businessDayStartUtc(ymd, tz);
};

const assertDateWithinPlan = (itemDate, weekStart, weekEnd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const d = businessTime.businessDayKeyFromUtcInstant(itemDate, tz);
  const ws = businessTime.businessDayKeyFromUtcInstant(weekStart, tz);
  const we = businessTime.businessDayKeyFromUtcInstant(weekEnd, tz);
  if (d < ws || d > we) {
    throw new ApiError(400, 'Plan item date must fall within the weekly plan range');
  }
};

/** No mutation on read: invalid sequences fail fast so data can be fixed explicitly (e.g. backfill script). */
const assertSequenceIntegrityForExecutionDay = (items) => {
  if (!items?.length) return;
  const seqs = items.map((i) => Number(i.sequenceOrder));
  for (const s of seqs) {
    if (!Number.isFinite(s) || s < 1) {
      throw new ApiError(
        422,
        'Plan items for this day have invalid sequenceOrder. Fix data or run scripts/backfillPlanItemSequences.js.'
      );
    }
  }
  if (new Set(seqs).size !== seqs.length) {
    throw new ApiError(
      422,
      'Duplicate sequenceOrder for this day. Fix the weekly plan before execution.'
    );
  }
};

const listPopulate = [
  { path: 'doctorId', select: 'name specialization' },
  { path: 'visitLogId' },
  { path: 'weeklyPlanId', select: 'weekStartDate weekEndDate status' }
];

const listByPlan = async (companyId, weeklyPlanId) => {
  return PlanItem.find({ companyId, weeklyPlanId, isDeleted: { $ne: true } })
    .populate(listPopulate)
    .sort({ date: 1, sequenceOrder: 1, createdAt: 1 })
    .lean();
};

const buildTodayExecution = async (companyId, employeeId, dateYmd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = dateYmd || businessTime.nowInBusinessTime(tz).toISODate();
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const items = await PlanItem.find({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  })
    .populate(listPopulate)
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .lean();

  assertSequenceIntegrityForExecutionDay(items);
  const summary = planExecution.summarizeExecutionCounts(items);
  const dayExecutionState = planExecution.deriveDayExecutionState(items);
  const pendingSorted = items
    .filter((i) => i.status === PLAN_ITEM_STATUS.PENDING)
    .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
  const nextPlanItem = pendingSorted[0] || null;

  const visitedItems = items.filter((i) => i.status === PLAN_ITEM_STATUS.VISITED);
  const outOfSequenceCount = visitedItems.filter((i) => i.wasOutOfOrder).length;
  const unplannedCompletedCount = visitedItems.filter((i) => i.isUnplanned).length;
  const coveragePercent = summary.total ? Math.round((summary.visited / summary.total) * 100) : 0;

  return {
    date: ymd,
    summary,
    dayExecutionState,
    nextPlanItem,
    endOfDayPreview: {
      visited: summary.visited,
      missed: summary.missed,
      coveragePercent,
      outOfSequenceCount,
      unplannedCompletedCount,
      dayComplete: dayExecutionState === DAY_EXECUTION_STATE.COMPLETED
    },
    items
  };
};

/** Pending-only list (dashboard bundle / legacy callers). */
const listTodayPending = async (companyId, employeeId, dateYmd, timeZone) => {
  const bundle = await buildTodayExecution(companyId, employeeId, dateYmd, timeZone);
  return bundle.items.filter((i) => i.status === PLAN_ITEM_STATUS.PENDING);
};

const assertProductPayload = async (companyId, productIds, primaryProductId) => {
  const ids = Array.isArray(productIds) ? productIds.map((x) => String(x)) : [];
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length) {
    const n = await Product.countDocuments({
      companyId,
      _id: { $in: uniq },
      isActive: true,
      isDeleted: { $ne: true }
    });
    if (n !== uniq.length) throw new ApiError(400, 'One or more products are invalid');
  }
  const pRaw = primaryProductId != null && String(primaryProductId).trim() !== '' ? String(primaryProductId) : null;
  if (pRaw) {
    if (!uniq.includes(pRaw)) {
      throw new ApiError(400, 'primaryProductId must be included in productsDiscussed');
    }
  }
  return { uniq, primary: pRaw ? new mongoose.Types.ObjectId(pRaw) : null };
};

const parseFollowUpDate = (raw, timeZone) => {
  if (raw == null || raw === '') return null;
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return businessTime.businessDayStartUtc(raw, tz);
  }
  const d = DateTime.fromISO(String(raw), { zone: 'utc' });
  if (!d.isValid) throw new ApiError(400, 'Invalid followUpDate');
  return d.toJSDate();
};

const bulkCreateForPlan = async (companyId, weeklyPlanId, items, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  if (!items?.length) throw new ApiError(400, 'At least one plan item is required');

  const plan = await WeeklyPlan.findOne({ _id: weeklyPlanId, companyId, isDeleted: { $ne: true } });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const employeeId = plan.medicalRepId;
  const businessTodayYmd = businessTime.nowInBusinessTime(tz).toISODate();
  const beforeWeek = planExecution.isBeforePlanWeek(plan, tz);

  /** @type {Map<number, { date: Date, rows: any[] }>} */
  const buckets = new Map();
  const dayOrder = [];

  for (const raw of items) {
    const date = normalizePlanItemDate(raw.date, tz);
    assertDateWithinPlan(date, plan.weekStartDate, plan.weekEndDate, tz);
    const ymd = businessTime.businessDayKeyFromUtcInstant(date, tz);

    if (!beforeWeek && planExecution.isPastPlanDay(ymd, businessTodayYmd)) {
      throw new ApiError(400, 'Cannot add plan items for dates that have already ended');
    }

    const type = raw.type || PLAN_ITEM_TYPE.DOCTOR_VISIT;
    let doctorId = raw.doctorId || null;
    let title = (raw.title || '').trim();
    const plannedTime = raw.plannedTime != null ? String(raw.plannedTime).trim().slice(0, 32) : '';

    if (type === PLAN_ITEM_TYPE.DOCTOR_VISIT) {
      if (!doctorId) throw new ApiError(400, 'doctorId is required for doctor visits');
      const doctor = await Doctor.findOne({ _id: doctorId, companyId, isActive: true, isDeleted: { $ne: true } });
      if (!doctor) throw new ApiError(404, 'Doctor not found');
    } else {
      doctorId = null;
      if (!title) throw new ApiError(400, 'title is required for other tasks');
    }

    const t = date.getTime();
    if (!buckets.has(t)) {
      buckets.set(t, { date, rows: [] });
      dayOrder.push(t);
    }
    buckets.get(t).rows.push({ type, doctorId, title, notes: raw.notes, plannedTime });
  }

  const docs = [];
  for (const timeKey of dayOrder) {
    const { date, rows } = buckets.get(timeKey);
    let seq = 1;
    for (const row of rows) {
      docs.push({
        companyId,
        weeklyPlanId,
        employeeId,
        date,
        sequenceOrder: seq,
        plannedTime: row.plannedTime || undefined,
        type: row.type,
        doctorId: row.doctorId || undefined,
        title: row.title || undefined,
        notes: row.notes,
        status: PLAN_ITEM_STATUS.PENDING,
        isUnplanned: false,
        createdBy: reqUser.userId
      });
      seq += 1;
    }
  }

  try {
    const created = await PlanItem.insertMany(docs);
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'planItem.bulkCreate',
      entityType: 'WeeklyPlan',
      entityId: weeklyPlanId,
      changes: { after: { count: created.length } }
    });
    return PlanItem.find({ _id: { $in: created.map((c) => c._id) } })
      .populate('doctorId', 'name specialization')
      .sort({ date: 1, sequenceOrder: 1 })
      .lean();
  } catch (e) {
    if (e && e.code === 11000) {
      throw new ApiError(
        400,
        'Duplicate or conflicting plan item (same doctor twice the same day, or sequence collision)'
      );
    }
    throw e;
  }
};

const firstPendingIdForDay = async (companyId, employeeId, dateDoc, session) => {
  const q = PlanItem.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    status: PLAN_ITEM_STATUS.PENDING,
    isDeleted: { $ne: true }
  })
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .select('_id');
  if (session) q.session(session);
  const doc = await q.lean();
  return doc ? String(doc._id) : null;
};

const markVisit = async (companyId, planItemId, body, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const item = await PlanItem.findOne({
      _id: planItemId,
      companyId,
      isDeleted: { $ne: true }
    }).session(session);

    if (!item) throw new ApiError(404, 'Plan item not found');
    if (String(item.employeeId) !== String(reqUser.userId)) {
      throw new ApiError(403, 'You can only complete your own plan items');
    }
    if (item.status !== PLAN_ITEM_STATUS.PENDING) {
      throw new ApiError(400, 'Only pending plan items can be marked as visited');
    }

    const nextId = await firstPendingIdForDay(companyId, reqUser.userId, item.date, session);
    const isOutOfOrder = Boolean(nextId && String(planItemId) !== nextId);
    const strictSeq = String(env.STRICT_VISIT_SEQUENCE || '0') === '1';

    if (isOutOfOrder) {
      if (strictSeq) {
        throw new ApiError(
          403,
          'This visit is not next in your planned sequence. Complete earlier visits first, or ask an admin to adjust the plan.'
        );
      }
      const reason = body.outOfOrderReason != null ? String(body.outOfOrderReason).trim() : '';
      if (reason.length < 3) {
        throw new ApiError(400, 'Out-of-sequence visits require outOfOrderReason (at least 3 characters).');
      }
    }

    await attendanceService.assertEmployeePresentForVisitDate(companyId, reqUser.userId, item.date, tz);

    const visitTime = body.visitTime
      ? DateTime.fromISO(String(body.visitTime), { zone: 'utc' }).toJSDate()
      : businessTime.utcNow();
    if (body.visitTime && Number.isNaN(visitTime.getTime())) throw new ApiError(400, 'Invalid visitTime');

    const doctorId =
      item.type === PLAN_ITEM_TYPE.DOCTOR_VISIT ? item.doctorId : body.doctorId || null;

    if (item.type === PLAN_ITEM_TYPE.DOCTOR_VISIT && !doctorId) {
      throw new ApiError(400, 'Plan item is missing doctor');
    }

    const parseOpt = (x) => {
      if (x == null) return undefined;
      const d = DateTime.fromISO(String(x), { zone: 'utc' });
      if (!d.isValid) throw new ApiError(400, 'Invalid date');
      return d.toJSDate();
    };

    const { uniq, primary } = await assertProductPayload(
      companyId,
      body.productsDiscussed,
      body.primaryProductId
    );
    const pDiscussed = uniq.map((id) => new mongoose.Types.ObjectId(id));
    const followUpDate = parseFollowUpDate(body.followUpDate, tz);

    let samplesQty = null;
    if (body.samplesQty != null && body.samplesQty !== '') {
      const n = Number(body.samplesQty);
      if (!Number.isInteger(n) || n < 0) throw new ApiError(400, 'samplesQty must be a non-negative integer');
      samplesQty = n;
    }

    const [visitLog] = await VisitLog.create(
      [
        {
          companyId,
          planItemId: item._id,
          employeeId: reqUser.userId,
          doctorId,
          visitTime,
          checkInTime: body.checkInTime != null ? parseOpt(body.checkInTime) : undefined,
          checkOutTime: body.checkOutTime != null ? parseOpt(body.checkOutTime) : undefined,
          location:
            body.location?.lat != null && body.location?.lng != null
              ? { lat: body.location.lat, lng: body.location.lng }
              : undefined,
          notes: body.notes,
          orderTaken: Boolean(body.orderTaken),
          productsDiscussed: pDiscussed,
          primaryProductId: primary,
          samplesQty,
          samplesGiven:
            body.samplesGiven != null ? String(body.samplesGiven).trim().slice(0, 500) : undefined,
          followUpDate: followUpDate || undefined,
          createdBy: reqUser.userId
        }
      ],
      { session }
    );

    item.status = PLAN_ITEM_STATUS.VISITED;
    item.visitLogId = visitLog._id;
    item.actualVisitTime = visitTime;
    item.wasOutOfOrder = isOutOfOrder;
    item.outOfOrderReason = isOutOfOrder ? String(body.outOfOrderReason).trim() : null;
    item.updatedBy = reqUser.userId;
    await item.save({ session });

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'planItem.markVisit',
      entityType: 'PlanItem',
      entityId: item._id,
      changes: { after: item.toObject(), wasOutOfOrder: isOutOfOrder }
    });

    const lean = await PlanItem.findById(item._id)
      .populate('doctorId', 'name specialization')
      .populate('visitLogId')
      .lean();
    return { ...lean, executionMeta: { wasOutOfOrder: isOutOfOrder } };
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const loadPlanForItemLock = async (planRef) => {
  if (!planRef) return null;
  if (typeof planRef === 'object' && planRef.weekStartDate) return planRef;
  return WeeklyPlan.findById(planRef).lean();
};

const updateByAdmin = async (companyId, planItemId, data, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const item = await PlanItem.findOne({ _id: planItemId, companyId, isDeleted: { $ne: true } });
  if (!item) throw new ApiError(404, 'Plan item not found');

  const plan = await loadPlanForItemLock(item.weeklyPlanId);
  const ymd = businessTime.businessDayKeyFromUtcInstant(item.date, tz);
  const today = businessTime.nowInBusinessTime(tz).toISODate();
  const locked =
    plan && !planExecution.isBeforePlanWeek(plan, tz) && planExecution.isPastPlanDay(ymd, today);

  const patchKeys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (locked && patchKeys.some((k) => k !== 'notes')) {
    throw new ApiError(400, 'This calendar day is locked; only notes can be edited');
  }

  const before = item.toObject();
  if (data.status !== undefined) {
    if (locked) throw new ApiError(400, 'Cannot change status for locked days');
    if (!Object.values(PLAN_ITEM_STATUS).includes(data.status)) {
      throw new ApiError(400, 'Invalid status');
    }
    item.status = data.status;
    if (data.status !== PLAN_ITEM_STATUS.VISITED) {
      item.visitLogId = null;
      item.actualVisitTime = null;
    }
  }
  if (data.notes !== undefined) item.notes = data.notes;
  item.updatedBy = reqUser.userId;
  await item.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'planItem.updateAdmin',
    entityType: 'PlanItem',
    entityId: item._id,
    changes: { before, after: item.toObject() }
  });

  return PlanItem.findById(item._id)
    .populate('doctorId', 'name specialization')
    .populate('visitLogId')
    .lean();
};

const reorderForDay = async (companyId, payload, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { weeklyPlanId, date: dateStr, orderedPlanItemIds } = payload;
  if (!orderedPlanItemIds?.length) throw new ApiError(400, 'orderedPlanItemIds is required');

  const plan = await WeeklyPlan.findOne({ _id: weeklyPlanId, companyId, isDeleted: { $ne: true } }).lean();
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const dateDoc = businessTime.businessDayStartUtc(String(dateStr).trim(), tz);
  const ymd = businessTime.businessDayKeyFromUtcInstant(dateDoc, tz);
  const today = businessTime.nowInBusinessTime(tz).toISODate();

  if (!planExecution.canEditPlanItemStructure(ymd, today, plan, tz)) {
    throw new ApiError(400, 'Cannot reorder visits on a locked day');
  }

  const ids = orderedPlanItemIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const items = await PlanItem.find({
    _id: { $in: ids },
    companyId,
    weeklyPlanId,
    date: dateDoc,
    isDeleted: { $ne: true }
  }).lean();

  if (items.length !== ids.length) throw new ApiError(400, 'Invalid plan items for reorder');

  const bulk = orderedPlanItemIds.map((idStr, idx) => ({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(String(idStr)), companyId },
      update: { $set: { sequenceOrder: idx + 1, updatedBy: reqUser.userId } }
    }
  }));
  await PlanItem.bulkWrite(bulk);

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'planItem.reorder',
    entityType: 'WeeklyPlan',
    entityId: weeklyPlanId,
    changes: { after: { date: ymd, count: ids.length } }
  });

  return PlanItem.find({
    companyId,
    weeklyPlanId,
    date: dateDoc,
    isDeleted: { $ne: true }
  })
    .populate('doctorId', 'name specialization')
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .lean();
};

const findOrCreateWeeklyPlanContainingDay = async (companyId, employeeId, ymd, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const candidates = await WeeklyPlan.find({
    companyId,
    medicalRepId: employeeId,
    isDeleted: { $ne: true }
  }).sort({ weekStartDate: -1 });

  for (const p of candidates) {
    const ws = businessTime.businessDayKeyFromUtcInstant(p.weekStartDate, tz);
    const we = businessTime.businessDayKeyFromUtcInstant(p.weekEndDate, tz);
    if (ymd >= ws && ymd <= we) return p;
  }

  const { mondayYmd, sundayYmd } = planExecution.mondaySundayRangeContainingYmd(ymd, tz);
  const plan = await WeeklyPlan.create({
    companyId,
    medicalRepId: employeeId,
    weekStartDate: businessTime.businessDayStartUtc(mondayYmd, tz),
    weekEndDate: businessTime.businessDayToUtcRange(sundayYmd, tz).$lte,
    status: WEEKLY_PLAN_STATUS.ACTIVE,
    notes: 'Auto-created for field execution (unplanned visit)',
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.autoCreate',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { after: plan.toObject() }
  });
  return plan;
};

const nextSequenceForDay = async (companyId, employeeId, dateDoc) => {
  const agg = await PlanItem.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(String(companyId)),
        employeeId: new mongoose.Types.ObjectId(String(employeeId)),
        date: dateDoc,
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: null, maxSeq: { $max: '$sequenceOrder' } } }
  ]);
  const max = agg[0]?.maxSeq || 0;
  return max + 1;
};

const createUnplannedAsPlanItem = async (companyId, body, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { doctorId, notes, orderTaken, location, visitTime, checkInTime, checkOutTime, unplannedReason } = body;
  if (!doctorId) throw new ApiError(400, 'Doctor is required for an unplanned visit');
  if (!unplannedReason || !Object.values(UNPLANNED_VISIT_REASON).includes(unplannedReason)) {
    throw new ApiError(400, 'unplannedReason is required (EMERGENCY, AVAILABLE_UNEXPECTEDLY, or OTHER)');
  }

  const doctor = await Doctor.findOne({ _id: doctorId, companyId, isActive: true, isDeleted: { $ne: true } });
  if (!doctor) throw new ApiError(404, 'Doctor not found');

  const vt = visitTime
    ? DateTime.fromISO(String(visitTime), { zone: 'utc' }).toJSDate()
    : businessTime.utcNow();
  if (visitTime && Number.isNaN(vt.getTime())) throw new ApiError(400, 'Invalid visitTime');

  await attendanceService.assertEmployeePresentForVisitDate(companyId, reqUser.userId, vt, tz);

  const ymd = businessTime.businessDayKeyFromUtcInstant(vt, tz);
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const plan = await findOrCreateWeeklyPlanContainingDay(companyId, reqUser.userId, ymd, reqUser, tz);
  const seq = await nextSequenceForDay(companyId, reqUser.userId, dateDoc);

  const parseOpt = (x) => {
    if (x == null || x === '') return undefined;
    const d = DateTime.fromISO(String(x), { zone: 'utc' });
    if (!d.isValid) throw new ApiError(400, 'Invalid date');
    return d.toJSDate();
  };

  const { uniq, primary } = await assertProductPayload(
    companyId,
    body.productsDiscussed,
    body.primaryProductId
  );
  const pDiscussed = uniq.map((id) => new mongoose.Types.ObjectId(id));
  const followUpDate = parseFollowUpDate(body.followUpDate, tz);

  let samplesQty = null;
  if (body.samplesQty != null && body.samplesQty !== '') {
    const n = Number(body.samplesQty);
    if (!Number.isInteger(n) || n < 0) throw new ApiError(400, 'samplesQty must be a non-negative integer');
    samplesQty = n;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const item = await PlanItem.create(
      [
        {
          companyId,
          weeklyPlanId: plan._id,
          employeeId: reqUser.userId,
          date: dateDoc,
          sequenceOrder: seq,
          type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
          doctorId,
          isUnplanned: true,
          unplannedReason,
          status: PLAN_ITEM_STATUS.VISITED,
          actualVisitTime: vt,
          notes: notes || undefined,
          createdBy: reqUser.userId
        }
      ],
      { session }
    );
    const pi = item[0];

    const [visitLog] = await VisitLog.create(
      [
        {
          companyId,
          planItemId: pi._id,
          employeeId: reqUser.userId,
          doctorId,
          visitTime: vt,
          checkInTime: checkInTime != null ? parseOpt(checkInTime) : undefined,
          checkOutTime: checkOutTime != null ? parseOpt(checkOutTime) : undefined,
          location:
            location?.lat != null && location?.lng != null ? { lat: location.lat, lng: location.lng } : undefined,
          notes,
          orderTaken: Boolean(orderTaken),
          productsDiscussed: pDiscussed,
          primaryProductId: primary,
          samplesQty,
          samplesGiven:
            body.samplesGiven != null ? String(body.samplesGiven).trim().slice(0, 500) : undefined,
          followUpDate: followUpDate || undefined,
          createdBy: reqUser.userId
        }
      ],
      { session }
    );

    pi.visitLogId = visitLog._id;
    await pi.save({ session });

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'visit.unplanned',
      entityType: 'VisitLog',
      entityId: visitLog._id,
      changes: { after: visitLog.toObject(), planItemId: String(pi._id) }
    });

    const lean = await PlanItem.findById(pi._id)
      .populate('doctorId', 'name specialization')
      .populate('visitLogId')
      .lean();
    return { planItem: lean, visitLog: visitLog.toObject ? visitLog.toObject() : visitLog };
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
};

const markMissedForCompanyBusinessDay = async (companyId, ymd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const res = await PlanItem.updateMany(
    {
      companyId,
      date: dateDoc,
      status: PLAN_ITEM_STATUS.PENDING,
      isDeleted: { $ne: true }
    },
    { $set: { status: PLAN_ITEM_STATUS.MISSED } }
  );
  return res.modifiedCount || 0;
};

const runPlanItemsMissedTick = async () => {
  const Company = require('../models/Company');
  const companies = await Company.find({ isActive: true }).select('_id timeZone').lean();
  let n = 0;
  for (const c of companies) {
    const tz = businessTime.getTimeZone(c);
    const local = businessTime.nowInBusinessTime(tz);
    if (local.hour === 23 && local.minute >= 55) {
      const ymd = local.toISODate();
      n += await markMissedForCompanyBusinessDay(c._id, ymd, tz);
    }
  }
  return n;
};

module.exports = {
  listByPlan,
  listTodayPending,
  buildTodayExecution,
  bulkCreateForPlan,
  markVisit,
  updateByAdmin,
  reorderForDay,
  createUnplannedAsPlanItem,
  findOrCreateWeeklyPlanContainingDay,
  markMissedForCompanyBusinessDay,
  runPlanItemsMissedTick,
  normalizePlanItemDate
};
