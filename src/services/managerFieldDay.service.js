const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const ManagerFieldDay = require('../models/ManagerFieldDay');
const WeeklyPlan = require('../models/WeeklyPlan');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const { CP_DAY_KEYS } = require('../constants/enums');
const auditService = require('./audit.service');
const fieldDayNotification = require('./managerFieldDayNotification.service');
const { isPlanLiveForPartnership, hideFieldDayRepsPendingApproval } = require('../utils/weeklyPlanPartnership');

const POPULATE = [
  { path: 'managerId', select: 'name' },
  { path: 'medicalRepIds', select: 'name' }
];

const idSet = (ids) => new Set((ids || []).map((id) => String(id)));

const inScope = (id, visibleRepIds) => {
  if (visibleRepIds === null) return true;
  if (!Array.isArray(visibleRepIds) || !visibleRepIds.length) return false;
  const needle = String(id);
  return visibleRepIds.some((x) => String(x) === needle);
};

const assertVisibleUser = (userId, visibleRepIds, notFoundMessage) => {
  if (!inScope(userId, visibleRepIds)) {
    throw new ApiError(403, notFoundMessage);
  }
};

/**
 * Dedupe, reject invalid ids, reject the manager selecting themselves.
 * Empty array is valid (clears the day).
 */
const normalizeMedicalRepIds = (rawIds, managerId) => {
  if (!Array.isArray(rawIds)) {
    throw new ApiError(400, 'medicalRepIds must be an array');
  }
  const out = [];
  const seen = new Set();
  const manager = String(managerId);
  for (const raw of rawIds) {
    if (raw == null || raw === '') continue;
    const id = String(raw);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ApiError(400, 'One or more selected reps are invalid');
    }
    if (id === manager) {
      throw new ApiError(400, 'A manager cannot select themselves as a field-day rep');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

const assertRepsInCallerScope = (repIds, visibleRepIds) => {
  for (const id of repIds) {
    if (!inScope(id, visibleRepIds)) {
      throw new ApiError(403, 'You can only select reps in your reporting subtree');
    }
  }
};

const assertRepsActiveInCompany = async (companyId, repIds) => {
  if (!repIds.length) return;
  const found = await User.find({
    _id: { $in: repIds },
    companyId,
    isActive: true
  })
    .select('_id')
    .lean();
  const valid = idSet(found.map((u) => u._id));
  for (const id of repIds) {
    if (!valid.has(String(id))) {
      throw new ApiError(400, 'One or more selected reps are invalid or inactive');
    }
  }
};

const loadPopulated = async (companyId, id) =>
  ManagerFieldDay.findOne({ _id: id, companyId }).populate(POPULATE);

const hydrate = async (doc, timeZone) => {
  if (!doc) return null;
  if (typeof doc.populate === 'function') {
    await doc.populate(POPULATE);
    await overlayUnpublishedFieldDayReps(doc, timeZone);
    return doc;
  }
  const populated = await ManagerFieldDay.findById(doc._id).populate(POPULATE);
  await overlayUnpublishedFieldDayReps(populated, timeZone);
  return populated;
};

/** Reps whose covering weekly plan is not accepted yet (fresh DB read). */
const unpublishedPartnershipRepIds = async (companyId, dateAnchor, repIds) => {
  const ids = (repIds || []).map((r) => String(r && r._id != null ? r._id : r)).filter(Boolean);
  if (!companyId || !dateAnchor || !ids.length) return new Set();
  const plans = await WeeklyPlan.find({
    companyId,
    medicalRepId: { $in: ids },
    weekStartDate: { $lte: dateAnchor },
    weekEndDate: { $gte: dateAnchor }
  })
    .select('medicalRepId status approvalRequired')
    .lean();
  const pending = new Set();
  for (const p of plans || []) {
    if (!isPlanLiveForPartnership(p)) pending.add(String(p.medicalRepId));
  }
  return pending;
};

/**
 * Do not show reps on Field Day while their covering weekly plan is still
 * pending approval. Does not persist — stored ids remain until retract/approve.
 */
const overlayUnpublishedFieldDayReps = async (docs, timeZone) => {
  const list = (Array.isArray(docs) ? docs : [docs]).filter(Boolean);
  if (!list.length) return docs;
  let tz;
  try {
    tz = businessTime.requireCompanyIanaZone(timeZone || 'UTC');
  } catch (_e) {
    tz = 'UTC';
  }
  for (const doc of list) {
    const raw = doc.medicalRepIds || [];
    if (!raw.length) continue;
    const ymd = doc.dateYmd || businessTime.businessDayKeyFromUtcInstant(doc.date, tz);
    const dateAnchor = businessTime.businessDayStartUtc(ymd, tz);
    const pending = await unpublishedPartnershipRepIds(doc.companyId, dateAnchor, raw);
    if (!pending.size) continue;
    doc.medicalRepIds = hideFieldDayRepsPendingApproval(raw, pending);
  }
  return docs;
};

const fireNotify = (payload) => {
  void fieldDayNotification.notifyFieldDayDiff(payload).catch(() => null);
};

/**
 * Internal Field Day mutate used by Partner sync. Does not re-enter Partner sync.
 */
const applyRepOnFieldDayInternal = async ({
  companyId,
  managerId,
  ymd,
  medicalRepId,
  action,
  reqUser,
  timeZone,
  notify = false
}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateAnchor = businessTime.businessDayStartUtc(String(ymd).trim(), tz);
  const id = String(medicalRepId);
  const manager = String(managerId);
  if (!id || id === manager) return { applied: false };

  let doc = await ManagerFieldDay.findOne({ companyId, managerId: manager, date: dateAnchor });
  const previousIds = doc ? (doc.medicalRepIds || []).map((x) => String(x)) : [];

  if (action === 'ADD') {
    if (previousIds.includes(id)) return { applied: false, reason: 'UNCHANGED' };
    if (!doc) {
      doc = await ManagerFieldDay.create({
        companyId,
        managerId: manager,
        date: dateAnchor,
        dateYmd: String(ymd).trim(),
        medicalRepIds: [id],
        createdBy: reqUser.userId,
        updatedBy: reqUser.userId
      });
    } else {
      doc.medicalRepIds = [...previousIds, id];
      doc.updatedBy = reqUser.userId;
      await doc.save();
    }
    if (notify) {
      const managerName = await managerDisplayName(manager);
      fireNotify({
        companyId,
        fieldDayId: doc._id,
        addedIds: [id],
        removedIds: [],
        managerName,
        dayYmd: String(ymd).trim()
      });
    }
    return { applied: true };
  }

  if (!doc || !previousIds.includes(id)) return { applied: false, reason: 'NOT_PRESENT' };
  const nextIds = previousIds.filter((x) => x !== id);
  if (!nextIds.length) {
    await doc.softDelete(reqUser.userId);
  } else {
    doc.medicalRepIds = nextIds;
    doc.updatedBy = reqUser.userId;
    await doc.save();
  }
  if (notify) {
    const managerName = await managerDisplayName(manager);
    fireNotify({
      companyId,
      fieldDayId: doc._id,
      addedIds: [],
      removedIds: [id],
      managerName,
      dayYmd: String(ymd).trim()
    });
  }
  return { applied: true };
};

const managerDisplayName = async (managerId) => {
  const u = await User.findById(managerId).select('name').lean();
  return u?.name || null;
};

const upsertForManager = async (companyId, data, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const visibleRepIds = opts.visibleRepIds;
  const callerId = String(reqUser.userId);
  const targetManagerId = data.managerId ? String(data.managerId) : callerId;

  assertVisibleUser(targetManagerId, visibleRepIds, 'You cannot record a field day for this manager');

  const ymd = String(data.date).trim();
  const dateAnchor = businessTime.businessDayStartUtc(ymd, tz);
  const repIds = normalizeMedicalRepIds(data.medicalRepIds, targetManagerId);
  assertRepsInCallerScope(repIds, visibleRepIds);
  await assertRepsActiveInCompany(companyId, repIds);

  let existing = await ManagerFieldDay.findOne({
    companyId,
    managerId: targetManagerId,
    date: dateAnchor
  });

  const previousIds = existing ? (existing.medicalRepIds || []).map((id) => String(id)) : [];
  const addedIds = repIds.filter((id) => !previousIds.includes(id));
  const removedIds = previousIds.filter((id) => !repIds.includes(id));

  if (!opts.skipPartnerSync && addedIds.length) {
    const partnershipSync = require('./partnershipSync.service');
    await partnershipSync.assertFieldDayAddsAllowed(companyId, targetManagerId, addedIds, ymd, tz);
  }

  if (!repIds.length) {
    if (!existing) {
      return null;
    }
    const removedIds = previousIds;
    await existing.softDelete(reqUser.userId);
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'managerFieldDay.delete',
      entityType: 'ManagerFieldDay',
      entityId: existing._id,
      changes: { before: { medicalRepIds: previousIds }, after: { isDeleted: true } }
    });
    const managerName = await managerDisplayName(targetManagerId);
    fireNotify({
      companyId,
      fieldDayId: existing._id,
      addedIds: [],
      removedIds,
      managerName,
      dayYmd: ymd
    });
    if (!opts.skipPartnerSync && removedIds.length) {
      const partnershipSync = require('./partnershipSync.service');
      await partnershipSync.syncFieldDaysForRepDiff({
        companyId,
        managerId: targetManagerId,
        ymd,
        addedIds: [],
        removedIds,
        reqUser,
        timeZone: tz
      });
    }
    return null;
  }

  if (!existing) {
    existing = await ManagerFieldDay.create({
      companyId,
      managerId: targetManagerId,
      date: dateAnchor,
      dateYmd: ymd,
      medicalRepIds: repIds,
      notes: data.notes != null ? String(data.notes).trim() : '',
      createdBy: reqUser.userId,
      updatedBy: reqUser.userId
    });
    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'managerFieldDay.create',
      entityType: 'ManagerFieldDay',
      entityId: existing._id,
      changes: { after: { medicalRepIds: repIds, dateYmd: ymd } }
    });
    const managerName = await managerDisplayName(targetManagerId);
    fireNotify({
      companyId,
      fieldDayId: existing._id,
      addedIds: repIds,
      removedIds: [],
      managerName,
      dayYmd: ymd
    });
    if (!opts.skipPartnerSync && addedIds.length) {
      const partnershipSync = require('./partnershipSync.service');
      await partnershipSync.syncFieldDaysForRepDiff({
        companyId,
        managerId: targetManagerId,
        ymd,
        addedIds,
        removedIds: [],
        reqUser,
        timeZone: tz
      });
    }
    return hydrate(existing, tz);
  }

  existing.medicalRepIds = repIds;
  if (data.notes !== undefined) existing.notes = String(data.notes).trim();
  existing.dateYmd = ymd;
  existing.updatedBy = reqUser.userId;
  await existing.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'managerFieldDay.update',
    entityType: 'ManagerFieldDay',
    entityId: existing._id,
    changes: { before: { medicalRepIds: previousIds }, after: { medicalRepIds: repIds } }
  });

  if (addedIds.length || removedIds.length) {
    const managerName = await managerDisplayName(targetManagerId);
    fireNotify({
      companyId,
      fieldDayId: existing._id,
      addedIds,
      removedIds,
      managerName,
      dayYmd: ymd
    });
  }

  if (!opts.skipPartnerSync && (addedIds.length || removedIds.length)) {
    const partnershipSync = require('./partnershipSync.service');
    await partnershipSync.syncFieldDaysForRepDiff({
      companyId,
      managerId: targetManagerId,
      ymd,
      addedIds,
      removedIds,
      reqUser,
      timeZone: tz
    });
  }

  return hydrate(existing, tz);
};

const getMeForDate = async (companyId, ymd, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const visibleRepIds = opts.visibleRepIds;
  const managerId = String(reqUser.userId);
  assertVisibleUser(managerId, visibleRepIds, 'You cannot view this field day');
  const dateAnchor = businessTime.businessDayStartUtc(String(ymd).trim(), tz);
  const doc = await ManagerFieldDay.findOne({ companyId, managerId, date: dateAnchor }).populate(POPULATE);
  await overlayUnpublishedFieldDayReps(doc, tz);
  return doc;
};

const list = async (companyId, query, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const visibleRepIds = opts.visibleRepIds;
  const from = String(query.from).trim();
  const to = String(query.to).trim();
  const fromAnchor = businessTime.businessDayStartUtc(from, tz);
  const toAnchor = businessTime.businessDayStartUtc(to, tz);
  if (fromAnchor > toAnchor) {
    throw new ApiError(400, 'from must be on or before to');
  }

  const filter = {
    companyId,
    date: { $gte: fromAnchor, $lte: toAnchor }
  };

  if (query.managerId) {
    assertVisibleUser(query.managerId, visibleRepIds, 'You cannot view field days for this manager');
    filter.managerId = query.managerId;
  } else if (visibleRepIds === null) {
    // Admin: all managers in range unless filtered.
  } else {
    filter.managerId = reqUser.userId;
  }

  const docs = await ManagerFieldDay.find(filter).sort({ date: 1 }).populate(POPULATE);
  await overlayUnpublishedFieldDayReps(docs, tz);
  return docs;
};

const getById = async (companyId, id, opts = {}) => {
  const doc = await loadPopulated(companyId, id);
  if (!doc) throw new ApiError(404, 'Field day not found');
  const managerId = doc.managerId?._id ?? doc.managerId;
  assertVisibleUser(managerId, opts.visibleRepIds, 'Field day not found');
  await overlayUnpublishedFieldDayReps(doc, opts.timeZone);
  return doc;
};

const updateById = async (companyId, id, data, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const doc = await ManagerFieldDay.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Field day not found');
  const managerId = String(doc.managerId);
  assertVisibleUser(managerId, opts.visibleRepIds, 'Field day not found');

  const ymd = doc.dateYmd || businessTime.businessDayKeyFromUtcInstant(doc.date, tz);
  const nextIds =
    data.medicalRepIds !== undefined
      ? normalizeMedicalRepIds(data.medicalRepIds, managerId)
      : (doc.medicalRepIds || []).map((x) => String(x));

  if (data.medicalRepIds !== undefined) {
    assertRepsInCallerScope(nextIds, opts.visibleRepIds);
    await assertRepsActiveInCompany(companyId, nextIds);
  }

  if (data.medicalRepIds !== undefined && !nextIds.length) {
    return upsertForManager(
      companyId,
      { date: ymd, medicalRepIds: [], notes: data.notes, managerId },
      reqUser,
      tz,
      opts
    );
  }

  const previousIds = (doc.medicalRepIds || []).map((x) => String(x));
  const addedIds = nextIds.filter((id) => !previousIds.includes(id));
  const removedIds = previousIds.filter((id) => !nextIds.includes(id));

  if (!opts.skipPartnerSync && data.medicalRepIds !== undefined && addedIds.length) {
    const partnershipSync = require('./partnershipSync.service');
    await partnershipSync.assertFieldDayAddsAllowed(companyId, managerId, addedIds, ymd, tz);
  }

  if (data.medicalRepIds !== undefined) doc.medicalRepIds = nextIds;
  if (data.notes !== undefined) doc.notes = String(data.notes).trim();
  doc.updatedBy = reqUser.userId;
  await doc.save();

  if (addedIds.length || removedIds.length) {
    const managerName = await managerDisplayName(managerId);
    fireNotify({
      companyId,
      fieldDayId: doc._id,
      addedIds,
      removedIds,
      managerName,
      dayYmd: ymd
    });
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'managerFieldDay.update',
    entityType: 'ManagerFieldDay',
    entityId: doc._id,
    changes: { before: { medicalRepIds: previousIds }, after: { medicalRepIds: nextIds } }
  });

  if (!opts.skipPartnerSync && data.medicalRepIds !== undefined && (addedIds.length || removedIds.length)) {
    const partnershipSync = require('./partnershipSync.service');
    await partnershipSync.syncFieldDaysForRepDiff({
      companyId,
      managerId,
      ymd,
      addedIds,
      removedIds,
      reqUser,
      timeZone: tz
    });
  }

  return hydrate(doc, tz);
};

const removeById = async (companyId, id, reqUser, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const doc = await ManagerFieldDay.findOne({ _id: id, companyId });
  if (!doc) throw new ApiError(404, 'Field day not found');
  const managerId = String(doc.managerId);
  assertVisibleUser(managerId, opts.visibleRepIds, 'Field day not found');
  const previousIds = (doc.medicalRepIds || []).map((x) => String(x));
  const ymd = doc.dateYmd || businessTime.businessDayKeyFromUtcInstant(doc.date, tz);
  await doc.softDelete(reqUser.userId);
  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'managerFieldDay.delete',
    entityType: 'ManagerFieldDay',
    entityId: doc._id,
    changes: { before: { medicalRepIds: previousIds }, after: { isDeleted: true } }
  });
  const managerName = await managerDisplayName(managerId);
  fireNotify({
    companyId,
    fieldDayId: doc._id,
    addedIds: [],
    removedIds: previousIds,
    managerName,
    dayYmd: ymd
  });
  if (!opts.skipPartnerSync && previousIds.length) {
    const partnershipSync = require('./partnershipSync.service');
    await partnershipSync.syncFieldDaysForRepDiff({
      companyId,
      managerId,
      ymd,
      addedIds: [],
      removedIds: previousIds,
      reqUser,
      timeZone: tz
    });
  }
  return { deleted: true };
};

/**
 * Rep ids this manager declared for a business-day date anchor.
 * Read-only — used by visit visibility. Does not touch WeeklyPlan / PlanItem.
 */
const medicalRepIdsForManagerOnDate = async (companyId, managerId, dateAnchor) => {
  if (!companyId || !managerId || !dateAnchor) return [];
  const doc = await ManagerFieldDay.findOne({
    companyId,
    managerId,
    date: dateAnchor
  })
    .select('medicalRepIds')
    .lean();
  if (!doc?.medicalRepIds?.length) return [];
  const manager = String(managerId);
  const out = [];
  const seen = new Set();
  for (const raw of doc.medicalRepIds) {
    const id = String(raw && raw._id != null ? raw._id : raw);
    if (!id || id === manager || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const pending = await unpublishedPartnershipRepIds(companyId, dateAnchor, out);
  return hideFieldDayRepsPendingApproval(out, pending);
};

/**
 * Read-only: which weekday partner slot on a weekly plan matches `ymd`.
 * Does not write partnerByDay.
 */
const partnerIdOnPlanForYmd = (plan, ymd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dt = DateTime.fromISO(String(ymd), { zone: tz });
  if (!dt.isValid) return null;
  const key = CP_DAY_KEYS[dt.weekday - 1];
  const raw = plan?.partnerByDay?.[key];
  if (!raw) return null;
  return String(raw._id || raw);
};

/**
 * Reps whose weekly plan lists this manager as Partner for days in [from, to].
 * Read-only overlay for the Field Day screen — never writes WeeklyPlan.
 */
const partnerListingsForManager = async (companyId, managerId, fromYmd, toYmd, timeZone, opts = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const fromAnchor = businessTime.businessDayStartUtc(String(fromYmd).trim(), tz);
  const toAnchor = businessTime.businessDayStartUtc(String(toYmd).trim(), tz);
  if (fromAnchor > toAnchor) {
    throw new ApiError(400, 'from must be on or before to');
  }

  const mid = new mongoose.Types.ObjectId(String(managerId));
  const filter = {
    companyId,
    weekStartDate: { $lte: toAnchor },
    weekEndDate: { $gte: fromAnchor },
    $or: CP_DAY_KEYS.map((k) => ({ [`partnerByDay.${k}`]: mid }))
  };
  if (opts.visibleRepIds !== null && opts.visibleRepIds !== undefined) {
    filter.medicalRepId = { $in: opts.visibleRepIds };
  }

  const plans = await WeeklyPlan.find(filter)
    .select('medicalRepId weekStartDate weekEndDate partnerByDay')
    .populate('medicalRepId', 'name')
    .lean();

  const byYmd = {};
  let cursor = DateTime.fromISO(String(fromYmd).trim(), { zone: tz });
  const last = DateTime.fromISO(String(toYmd).trim(), { zone: tz });
  while (cursor.toMillis() <= last.toMillis()) {
    byYmd[cursor.toISODate()] = [];
    cursor = cursor.plus({ days: 1 });
  }

  const manager = String(managerId);
  for (const plan of plans || []) {
    const start = businessTime.businessDayKeyFromUtcInstant(plan.weekStartDate, tz);
    const end = businessTime.businessDayKeyFromUtcInstant(plan.weekEndDate, tz);
    let d = DateTime.fromISO(start, { zone: tz });
    const planEnd = DateTime.fromISO(end, { zone: tz });
    while (d.toMillis() <= planEnd.toMillis()) {
      const ymd = d.toISODate();
      if (byYmd[ymd] && partnerIdOnPlanForYmd(plan, ymd, tz) === manager) {
        const rep = plan.medicalRepId;
        const id = String(rep?._id || rep || '');
        if (id && id !== manager && !byYmd[ymd].some((r) => r._id === id)) {
          byYmd[ymd].push({ _id: id, name: rep?.name || null });
        }
      }
      d = d.plus({ days: 1 });
    }
  }
  return byYmd;
};

module.exports = {
  normalizeMedicalRepIds,
  assertRepsInCallerScope,
  medicalRepIdsForManagerOnDate,
  partnerIdOnPlanForYmd,
  partnerListingsForManager,
  applyRepOnFieldDayInternal,
  upsertForManager,
  getMeForDate,
  list,
  getById,
  updateById,
  removeById
};
