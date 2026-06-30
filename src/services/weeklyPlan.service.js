const mongoose = require('mongoose');
const WeeklyPlan = require('../models/WeeklyPlan');
const PlanItem = require('../models/PlanItem');
const Company = require('../models/Company');
const User = require('../models/User');
const CallPoint = require('../models/CallPoint');
const ApiError = require('../utils/ApiError');
const { CP_DAY_KEYS } = require('../constants/enums');
const { parsePagination } = require('../utils/pagination');
const auditService = require('./audit.service');
const planItemService = require('./planItem.service');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const businessTime = require('../utils/businessTime');
const planExecution = require('../utils/planExecution.util');
const checkInPolicyServiceV2 = require('./checkInPolicyServiceV2');
const { DateTime } = require('luxon');
const { PLAN_ITEM_STATUS, WEEKLY_PLAN_STATUS } = require('../constants/enums');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { applyOrderMedicalRepScope, assertOrderVisibleToUser } = require('../utils/orderScope.util');

/**
 * Validate & normalize a per-day CP selection. Each provided id must reference an
 * ACTIVE CP in the caller's company; empty strings / nulls clear that day.
 * Returns a clean { day: ObjectId|null } object, or undefined when nothing supplied.
 */
const normalizeCpByDay = async (companyId, raw) => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  const out = {};
  const idsToCheck = new Set();
  for (const day of CP_DAY_KEYS) {
    const val = raw[day];
    if (val === undefined) continue;
    if (val === null || val === '') {
      out[day] = null;
      continue;
    }
    if (!mongoose.Types.ObjectId.isValid(val)) {
      throw new ApiError(400, `Invalid CP id for ${day}`);
    }
    out[day] = val;
    idsToCheck.add(String(val));
  }

  if (idsToCheck.size) {
    const found = await CallPoint.find({
      _id: { $in: [...idsToCheck] },
      companyId,
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    const valid = new Set(found.map((c) => String(c._id)));
    for (const id of idsToCheck) {
      if (!valid.has(id)) {
        throw new ApiError(400, 'One or more selected CPs are invalid or inactive');
      }
    }
  }

  return out;
};

const list = async (companyId, query, timeZone = 'UTC', opts = {}) => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);
  const filter = { companyId };
  if (query.status) filter.status = query.status;
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.notes = { $regex: rx, $options: 'i' };
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);
  applyOrderMedicalRepScope(filter, opts.visibleRepIds, query.medicalRepId);
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

const create = async (companyId, data, reqUser, opts = {}) => {
  const targetRepId = data.medicalRepId || reqUser.userId;
  if (opts.visibleRepIds !== null && opts.visibleRepIds !== undefined) {
    const allowed = opts.visibleRepIds.some((id) => String(id) === String(targetRepId));
    if (!allowed) {
      throw new ApiError(403, 'You cannot create a plan for this medical rep');
    }
  }

  /**
   * Phase 2B: inherit `approvalRequired` from the company flag if the caller didn't pass one.
   * Per-plan storage means flipping the company flag later doesn't mutate in-flight plans.
   */
  let approvalRequired = data.approvalRequired;
  if (approvalRequired === undefined || approvalRequired === null) {
    const company = await Company.findOne({ _id: companyId, isDeleted: { $ne: true } })
      .select('weeklyPlanApprovalRequired')
      .lean();
    approvalRequired = !!(company && company.weeklyPlanApprovalRequired);
  }

  const cpByDay = await normalizeCpByDay(companyId, data.cpByDay);

  const plan = await WeeklyPlan.create({
    ...data,
    cpByDay: cpByDay === null ? undefined : cpByDay,
    approvalRequired,
    companyId,
    medicalRepId: targetRepId,
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

const update = async (companyId, id, data, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const plan = await WeeklyPlan.findOne({ _id: id, companyId });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  assertOrderVisibleToUser(plan, opts.visibleRepIds);

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
  const checkInConfigTouched = Object.prototype.hasOwnProperty.call(data, 'checkInConfiguration');
  const cpByDayTouched = Object.prototype.hasOwnProperty.call(data, 'cpByDay');
  let normalizedCpByDay;
  if (cpByDayTouched) {
    normalizedCpByDay = await normalizeCpByDay(companyId, data.cpByDay);
  }
  const rest = { ...data };
  delete rest.cpByDay;
  Object.assign(plan, rest);
  if (cpByDayTouched) {
    if (normalizedCpByDay === null) {
      plan.cpByDay = undefined;
    } else {
      /** Merge supplied days onto existing selection so partial updates don't clear other days. */
      const merged = { ...(plan.cpByDay ? plan.cpByDay.toObject?.() ?? plan.cpByDay : {}) };
      for (const [day, val] of Object.entries(normalizedCpByDay)) {
        merged[day] = val;
      }
      plan.cpByDay = merged;
    }
  }
  plan.updatedBy = reqUser.userId;
  await plan.save();
  if (checkInConfigTouched) {
    await checkInPolicyServiceV2.bumpAttendanceConfigVersion(companyId);
  }
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

const getByRep = async (companyId, repId, opts = {}) => {
  const filter = { companyId };
  applyOrderMedicalRepScope(filter, opts.visibleRepIds, repId);
  return WeeklyPlan.find(filter).sort({ weekStartDate: -1 });
};

const getById = async (companyId, id, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const plan = await WeeklyPlan.findOne({ _id: id, companyId, isDeleted: { $ne: true } })
    .populate('medicalRepId', 'name email')
    .populate(
      CP_DAY_KEYS.map((day) => ({ path: `cpByDay.${day}`, select: 'name latitude longitude isActive' }))
    );
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  assertOrderVisibleToUser(plan, opts.visibleRepIds);
  const planItems = await planItemService.listByPlan(companyId, id);
  const metrics = planExecution.computePlanMetrics(planItems, tz);
  const businessTodayYmd = businessTime.nowInBusinessTime(tz).toISODate();
  const beforeWeek = planExecution.isBeforePlanWeek(plan, tz);
  const companyPolicy = await checkInPolicyServiceV2.getCompanyForCheckInPolicy(companyId);
  return {
    ...plan.toObject(),
    planItems,
    executionMetrics: metrics,
    editLock: { beforePlanWeek: beforeWeek, businessTodayYmd },
    attendanceSystemMode: checkInPolicyServiceV2.isV2Mode(companyPolicy)
      ? 'CHECKIN_POLICY_V2'
      : 'LEGACY'
  };
};

const copyPreviousWeekIntoPlan = async (companyId, targetPlanId, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const target = await WeeklyPlan.findOne({ _id: targetPlanId, companyId, isDeleted: { $ne: true } });
  if (!target) throw new ApiError(404, 'Weekly plan not found');
  assertOrderVisibleToUser(target, opts.visibleRepIds);
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

/* ============================================================================
 * Phase 2B — Approval workflow
 * ============================================================================ */

/**
 * Confirm the caller is allowed to act as the manager for this plan's rep:
 *   - SUPER_ADMIN / admin.access bypass
 *   - or the rep is in the caller's reporting subtree (via User.managerId)
 *
 * Throws 403 otherwise. Returns the plan it loaded so the caller doesn't re-query.
 */
const assertCallerCanManagePlan = async (companyId, planId, reqUser, action = 'review') => {
  const plan = await WeeklyPlan.findOne({ _id: planId, companyId, isDeleted: { $ne: true } });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  const isAdmin = (reqUser?.permissions || []).includes('admin.access');
  if (isAdmin) return plan;

  const repId = plan.medicalRepId;
  if (String(repId) === String(reqUser.userId)) {
    /** Rep cannot review/approve their own plan. */
    throw new ApiError(403, `Cannot ${action} your own plan`);
  }
  const subtree = await resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: false, activeOnly: true });
  const inTree = subtree.some((id) => String(id) === String(repId));
  if (!inTree) {
    throw new ApiError(403, 'You can only ' + action + ' plans of users reporting to you');
  }
  return plan;
};

/**
 * PATCH-style: submit a DRAFT plan for manager approval. Allowed actors:
 *   - The plan owner (rep)
 *   - Anyone managing the plan owner (subtree containing the rep) — common for ASMs
 *     who maintain plans on behalf of their MRs
 *   - admin.access bypass
 */
const submit = async (companyId, planId, reqUser) => {
  const plan = await WeeklyPlan.findOne({ _id: planId, companyId, isDeleted: { $ne: true } });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const isAdmin = (reqUser?.permissions || []).includes('admin.access');
  const isOwner = String(plan.medicalRepId) === String(reqUser.userId);
  let isManagerOfOwner = false;
  if (!isAdmin && !isOwner) {
    const subtree = await resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: false, activeOnly: true });
    isManagerOfOwner = subtree.some((id) => String(id) === String(plan.medicalRepId));
  }
  if (!(isAdmin || isOwner || isManagerOfOwner)) {
    throw new ApiError(403, 'Only the plan owner or their manager can submit it for approval');
  }
  if (!plan.approvalRequired) {
    throw new ApiError(400, 'This plan does not require approval. Save it as ACTIVE directly.');
  }
  if (plan.status !== WEEKLY_PLAN_STATUS.DRAFT) {
    throw new ApiError(400, `Plan cannot be submitted from status ${plan.status}`);
  }
  const itemCount = await PlanItem.countDocuments({
    weeklyPlanId: plan._id,
    companyId,
    isDeleted: { $ne: true }
  });
  if (itemCount === 0) {
    throw new ApiError(400, 'Cannot submit an empty plan — add at least one plan item first');
  }

  const before = plan.toObject();
  plan.status = WEEKLY_PLAN_STATUS.SUBMITTED;
  plan.submittedAt = new Date();
  plan.rejectedReason = null;
  plan.updatedBy = reqUser.userId;
  await plan.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.submit',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { before, after: plan.toObject() }
  });
  return plan;
};

const approve = async (companyId, planId, reqUser) => {
  const plan = await assertCallerCanManagePlan(companyId, planId, reqUser, 'approve');
  if (plan.status !== WEEKLY_PLAN_STATUS.SUBMITTED) {
    throw new ApiError(400, `Plan must be SUBMITTED to approve (current: ${plan.status})`);
  }
  const before = plan.toObject();
  plan.status = WEEKLY_PLAN_STATUS.ACTIVE;
  plan.approvedAt = new Date();
  plan.approvedBy = reqUser.userId;
  plan.rejectedReason = null;
  plan.updatedBy = reqUser.userId;
  await plan.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.approve',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { before, after: plan.toObject() }
  });
  return plan;
};

const reject = async (companyId, planId, { reason } = {}, reqUser) => {
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'A rejection reason is required');
  }
  const plan = await assertCallerCanManagePlan(companyId, planId, reqUser, 'reject');
  if (plan.status !== WEEKLY_PLAN_STATUS.SUBMITTED) {
    throw new ApiError(400, `Plan must be SUBMITTED to reject (current: ${plan.status})`);
  }
  const before = plan.toObject();
  /** Reject sends the plan back to DRAFT so the rep can fix and re-submit. */
  plan.status = WEEKLY_PLAN_STATUS.DRAFT;
  plan.rejectedReason = String(reason).trim().slice(0, 1000);
  plan.submittedAt = null;
  plan.approvedAt = null;
  plan.approvedBy = null;
  plan.updatedBy = reqUser.userId;
  await plan.save();
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'weeklyPlan.reject',
    entityType: 'WeeklyPlan',
    entityId: plan._id,
    changes: { before, after: plan.toObject() }
  });
  return plan;
};

/**
 * Manager helper: list plans pending approval in the caller's subtree.
 * Used by the dashboard "team summary" widget and the manager's review queue.
 */
const pendingApprovals = async (companyId, reqUser) => {
  const isAdmin = (reqUser?.permissions || []).includes('admin.access');
  let userFilter;
  if (isAdmin) {
    userFilter = undefined;
  } else {
    const subtree = await resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: false, activeOnly: true });
    if (!subtree.length) return [];
    userFilter = { $in: subtree };
  }
  const filter = {
    companyId,
    status: WEEKLY_PLAN_STATUS.SUBMITTED,
    isDeleted: { $ne: true }
  };
  if (userFilter) filter.medicalRepId = userFilter;
  return WeeklyPlan.find(filter)
    .populate('medicalRepId', 'name email')
    .sort({ submittedAt: -1, weekStartDate: -1 })
    .limit(50)
    .lean();
};

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Basic nearest-neighbor reorder for one plan day. Uses optional client-supplied
 * coordinates; items without coords are appended sorted by city/location/name.
 */
const optimizeRoute = async (companyId, planId, payload, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { date: dateStr, startLat, startLng, itemCoordinates = {} } = payload;

  const plan = await WeeklyPlan.findOne({ _id: planId, companyId, isDeleted: { $ne: true } });
  if (!plan) throw new ApiError(404, 'Weekly plan not found');
  assertOrderVisibleToUser(plan, opts.visibleRepIds);

  const dateDoc = businessTime.businessDayStartUtc(String(dateStr).trim(), tz);
  const items = await PlanItem.find({
    companyId,
    weeklyPlanId: planId,
    date: dateDoc,
    isDeleted: { $ne: true }
  })
    .populate('doctorId', 'name city locationName doctorBrick zone')
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .lean();

  if (items.length <= 1) {
    return items;
  }

  const coords = new Map();
  for (const it of items) {
    const custom = itemCoordinates[String(it._id)];
    if (custom && typeof custom.lat === 'number' && typeof custom.lng === 'number') {
      coords.set(String(it._id), custom);
    }
  }

  const withCoords = items.filter((it) => coords.has(String(it._id)));
  const withoutCoords = items.filter((it) => !coords.has(String(it._id)));

  let ordered = [];
  if (withCoords.length >= 2) {
    const remaining = [...withCoords];
    let current =
      startLat != null && startLng != null
        ? { lat: startLat, lng: startLng }
        : coords.get(String(remaining[0]._id));
    while (remaining.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const c = coords.get(String(remaining[i]._id));
        const d = haversineKm(current, c);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      ordered.push(next);
      current = coords.get(String(next._id));
    }
  } else {
    ordered = [...withCoords];
  }

  withoutCoords.sort((a, b) => {
    const docA = a.doctorId || {};
    const docB = b.doctorId || {};
    const keyA = `${docA.city || ''}|${docA.locationName || ''}|${docA.name || ''}`;
    const keyB = `${docB.city || ''}|${docB.locationName || ''}|${docB.name || ''}`;
    return keyA.localeCompare(keyB);
  });

  const orderedPlanItemIds = [...ordered, ...withoutCoords].map((it) => String(it._id));
  return planItemService.reorderForDay(
    companyId,
    { weeklyPlanId: planId, date: dateStr, orderedPlanItemIds },
    reqUser,
    timeZone
  );
};

module.exports = {
  list,
  create,
  update,
  getByRep,
  getById,
  copyPreviousWeekIntoPlan,
  submit,
  approve,
  reject,
  pendingApprovals,
  optimizeRoute
};
