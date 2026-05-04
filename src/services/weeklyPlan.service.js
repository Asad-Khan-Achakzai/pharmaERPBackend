const WeeklyPlan = require('../models/WeeklyPlan');
const PlanItem = require('../models/PlanItem');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const planItemService = require('./planItem.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const businessTime = require('../utils/businessTime');
const planExecution = require('../utils/planExecution.util');
const { DateTime } = require('luxon');
const { PLAN_ITEM_STATUS } = require('../constants/enums');

const list = async (companyId, query, timeZone = 'UTC') => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.medicalRepId) filter.medicalRepId = query.medicalRepId;
  if (query.status) filter.status = query.status;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.notes = { $regex: rx, $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  const [docs, total] = await Promise.all([
    WeeklyPlan.find(filter).populate('medicalRepId', 'name').sort(sort).skip(skip).limit(limit),
    WeeklyPlan.countDocuments(filter)
  ]);
  const ids = docs.map((d) => d._id);
  let byPlan = {};
  if (ids.length) {
    const counts = await PlanItem.aggregate([
      { $match: { weeklyPlanId: { $in: ids }, companyId, isDeleted: { $ne: true } } },
      { $group: { _id: '$weeklyPlanId', n: { $sum: 1 } } }
    ]);
    byPlan = Object.fromEntries(counts.map((c) => [c._id.toString(), c.n]));
  }
  const enriched = docs.map((d) => {
    const o = d.toObject();
    o.planItemsCount = byPlan[d._id.toString()] || 0;
    return o;
  });
  return { docs: enriched, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  const plan = await WeeklyPlan.create({
    ...data,
    companyId,
    medicalRepId: data.medicalRepId || reqUser.userId,
    createdBy: reqUser.userId
  });
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.create',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { after: plan.toObject() }
  });
  return plan;
};

const update = async (companyId, id, data, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const plan = await WeeklyPlan.findOne({ _id: id, companyId });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const nItems = await PlanItem.countDocuments({ weeklyPlanId: id, companyId, isDeleted: { $ne: true } });
  if (nItems > 0 && !planExecution.isBeforePlanWeek(plan, tz)) {
    if (data.weekStartDate != null || data.weekEndDate != null) {
      throw new ApiError(
        400,
        'Week start/end cannot be changed after the plan week has begun when plan items exist'
      );
    }
  }

  const before = plan.toObject();
  Object.assign(plan, data);
  plan.updatedBy = reqUser.userId;
  await plan.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.update',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { before, after: plan.toObject() }
  });
  return plan;
};

const getByRep = async (companyId, repId) => {
  return WeeklyPlan.find({ companyId, medicalRepId: repId }).sort({ weekStartDate: -1 });
};

const getById = async (companyId, id, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const plan = await WeeklyPlan.findOne({ _id: id, companyId, isDeleted: { $ne: true } }).populate(
    'medicalRepId',
    'name email'
  );
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  const planItems = await planItemService.listByPlan(companyId, id);
  const metrics = planExecution.computePlanMetrics(planItems, tz);
  const businessTodayYmd = businessTime.nowInBusinessTime(tz).toISODate();
  const beforeWeek = planExecution.isBeforePlanWeek(plan, tz);
  return {
    ...plan.toObject(),
    planItems,
    executionMetrics: metrics,
    editLock: { beforePlanWeek: beforeWeek, businessTodayYmd }
  };
};

const copyPreviousWeekIntoPlan = async (companyId, targetPlanId, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const target = await WeeklyPlan.findOne({ _id: targetPlanId, companyId, isDeleted: { $ne: true } });
  if (!target) throw new ApiError(404, 'Weekly plan not found');
  if (!planExecution.isBeforePlanWeek(target, tz)) {
    throw new ApiError(400, 'You can only copy into a plan before its week starts');
  }

  const repId = target.medicalRepId;
  const tStartYmd = businessTime.businessDayKeyFromUtcInstant(target.weekStartDate, tz);

  const candidates = await WeeklyPlan.find({
    companyId,
    medicalRepId: repId,
    isDeleted: { $ne: true },
    _id: { $ne: target._id }
  }).lean();

  let prev = null;
  let bestEnd = '';
  for (const p of candidates) {
    const we = businessTime.businessDayKeyFromUtcInstant(p.weekEndDate, tz);
    if (we < tStartYmd && we > bestEnd) {
      bestEnd = we;
      prev = p;
    }
  }
  if (!prev) throw new ApiError(404, 'No previous weekly plan found for this rep');

  const pStartYmd = businessTime.businessDayKeyFromUtcInstant(prev.weekStartDate, tz);
  const dtTarget = DateTime.fromISO(tStartYmd, { zone: tz });
  const dtPrev = DateTime.fromISO(pStartYmd, { zone: tz });
  const deltaDays = Math.round(dtTarget.diff(dtPrev, 'days').days);

  const srcItems = await PlanItem.find({
    weeklyPlanId: prev._id,
    companyId,
    isDeleted: { $ne: true }
  }).lean();

  const docs = [];
  for (const it of srcItems) {
    const srcYmd = businessTime.businessDayKeyFromUtcInstant(it.date, tz);
    const newYmd = DateTime.fromISO(srcYmd, { zone: tz }).plus({ days: deltaDays }).toISODate();
    const newDate = businessTime.businessDayStartUtc(newYmd, tz);
    const { weekStartYmd, weekEndYmd } = planExecution.planWeekYmdBounds(target, tz);
    if (newYmd < weekStartYmd || newYmd > weekEndYmd) continue;

    docs.push({
      companyId,
      weeklyPlanId: target._id,
      employeeId: it.employeeId,
      date: newDate,
      sequenceOrder: Number(it.sequenceOrder) > 0 ? it.sequenceOrder : 1,
      plannedTime: it.plannedTime,
      type: it.type,
      doctorId: it.doctorId || undefined,
      title: it.title,
      notes: it.notes,
      status: PLAN_ITEM_STATUS.PENDING,
      isUnplanned: false,
      createdBy: reqUser.userId
    });
  }

  if (!docs.length) {
    throw new ApiError(400, 'No items from the previous plan fall inside this week window');
  }

  try {
    await PlanItem.insertMany(docs);
  } catch (e) {
    if (e && e.code === 11000) {
      throw new ApiError(400, 'Copy failed: duplicate doctor or sequence in this plan. Adjust targets first.');
    }
    throw e;
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.copyPreviousWeek',
    entityType: 'WeeklyPlan',
    entityId: target._id,
    changes: { after: { fromPlanId: String(prev._id), copiedCount: docs.length } }
  });

  return planItemService.listByPlan(companyId, target._id);
};

module.exports = { list, create, update, getByRep, getById, copyPreviousWeekIntoPlan };
