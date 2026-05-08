/**
 * Doctor coverage vs monthly visit targets (Phase 3 — read-side only).
 * Ownership: assignedRepId overrides; else doctor territory must fall under rep's territory brick/prefix.
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const Doctor = require('../models/Doctor');
const Territory = require('../models/Territory');
const VisitLog = require('../models/VisitLog');
const PlanItem = require('../models/PlanItem');
const businessTime = require('../utils/businessTime');
const { TERRITORY_KIND, PLAN_ITEM_TYPE, PLAN_ITEM_STATUS } = require('../constants/enums');
const { escapeRegex } = require('../utils/listQuery');
const mrepOwnership = require('./mrepOwnership.service');

const monthBoundsUtc = (yyyyMm, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  return {
    startUtc: startLocal.toUTC().toJSDate(),
    endUtc: endLocal.toUTC().toJSDate()
  };
};

/** First/last plan-item `date` anchors (business-day start UTC) for a calendar month in `tz`. */
const planItemDateBoundsForMonth = (yyyyMm, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  const startDoc = businessTime.businessDayStartUtc(startLocal.toISODate(), zone);
  const endDoc = businessTime.businessDayStartUtc(endLocal.toISODate(), zone);
  return { startDoc, endDoc };
};

async function brickIdsUnderTerritoryPrefix(companyId, materializedPathPrefix) {
  if (!materializedPathPrefix || materializedPathPrefix === '/') return [];
  const rx = new RegExp(`^${escapeRegex(materializedPathPrefix)}`);
  const bricks = await Territory.find({
    companyId,
    kind: TERRITORY_KIND.BRICK,
    materializedPath: rx,
    isDeleted: { $ne: true }
  })
    .select('_id')
    .lean();
  return bricks.map((b) => b._id);
}

const ownedDoctorsFilter = mrepOwnership.ownedDoctorsFilter;
const listOwnedDoctors = mrepOwnership.listOwnedDoctors;

const visitCountsForDoctorsInMonth = async (companyId, repId, doctorIds, yyyyMm, tz) => {
  if (!doctorIds.length) return new Map();
  const { startUtc, endUtc } = monthBoundsUtc(yyyyMm, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(repId));
  const dids = doctorIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const rows = await VisitLog.aggregate([
    {
      $match: {
        companyId: cid,
        employeeId: rid,
        doctorId: { $in: dids },
        visitTime: { $gte: startUtc, $lte: endUtc },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$doctorId', n: { $sum: 1 }, lastAt: { $max: '$visitTime' } } }
  ]);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r._id), { count: r.n, lastVisitedAt: r.lastAt });
  }
  return map;
};

const routeMissedCountsForDoctorsInMonth = async (companyId, repId, doctorIds, yyyyMm, tz) => {
  if (!doctorIds.length) return new Map();
  const { startDoc, endDoc } = planItemDateBoundsForMonth(yyyyMm, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(repId));
  const dids = doctorIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const rows = await PlanItem.aggregate([
    {
      $match: {
        companyId: cid,
        employeeId: rid,
        doctorId: { $in: dids },
        date: { $gte: startDoc, $lte: endDoc },
        type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
        status: PLAN_ITEM_STATUS.MISSED,
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$doctorId', n: { $sum: 1 } } }
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), r.n);
  return map;
};

const bandForCounts = (target, count) => {
  if (target == null || target <= 0) return 'none';
  if (count >= target) return 'green';
  if (count >= target - 1) return 'amber';
  return 'red';
};

const coverageForRepMonth = async (companyId, repId, yyyyMm, tz) => {
  const doctors = await listOwnedDoctors(companyId, repId);
  const ids = doctors.map((d) => d._id);
  const [counts, missedRoute] = await Promise.all([
    visitCountsForDoctorsInMonth(companyId, repId, ids, yyyyMm, tz),
    routeMissedCountsForDoctorsInMonth(companyId, repId, ids, yyyyMm, tz)
  ]);

  let withTarget = 0;
  let metOrExceeded = 0;
  const rows = doctors.map((d) => {
    const tid = String(d._id);
    const stat = counts.get(tid) || {};
    const count = stat.count || 0;
    const lastVisitedAt = stat.lastVisitedAt || null;
    const target =
      d.monthlyVisitTarget != null && Number.isFinite(Number(d.monthlyVisitTarget))
        ? Number(d.monthlyVisitTarget)
        : null;
    if (target != null && target > 0) {
      withTarget += 1;
      if (count >= target) metOrExceeded += 1;
    }
    const gap = target != null ? Math.max(0, target - count) : null;
    const own = mrepOwnership.ownershipForRepCoverageRow(d, repId);
    return {
      doctorId: tid,
      doctorName: d.name,
      target,
      actualVisits: count,
      gap,
      lastVisitedAt,
      band: bandForCounts(target, count),
      ownershipKind: own.kind,
      ownershipLabel: own.label,
      coverageStatus: mrepOwnership.coverageBandLabel(target, count),
      routeMissedCount: missedRoute.get(tid) || 0,
      metricsDefinition: 'coverageActualV1'
    };
  });

  const coveragePercent = withTarget > 0 ? Math.round((metOrExceeded / withTarget) * 100) : null;

  return {
    month: yyyyMm,
    repId: String(repId),
    coveragePercent,
    doctorsTracked: withTarget,
    metricsDefinition: 'coverageActualV1',
    doctors: rows
  };
};

const doctorsUnderTerritoryPrefix = async (companyId, territoryId) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const t = await Territory.findOne({ _id: territoryId, companyId: cid, isDeleted: { $ne: true } })
    .select('materializedPath kind')
    .lean();
  if (!t || !t.materializedPath) return [];

  const brickIds =
    t.kind === TERRITORY_KIND.BRICK ? [t._id] : await brickIdsUnderTerritoryPrefix(cid, t.materializedPath);

  if (!brickIds.length) return [];

  return Doctor.find({
    companyId: cid,
    territoryId: { $in: brickIds },
    isDeleted: { $ne: true }
  })
    .select('_id name monthlyVisitTarget assignedRepId territoryId')
    .lean();
};

const visitCountsForDoctorsCompanyWide = async (companyId, doctorIds, yyyyMm, tz) => {
  if (!doctorIds.length) return new Map();
  const { startUtc, endUtc } = monthBoundsUtc(yyyyMm, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const dids = doctorIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const rows = await VisitLog.aggregate([
    {
      $match: {
        companyId: cid,
        doctorId: { $in: dids },
        visitTime: { $gte: startUtc, $lte: endUtc },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$doctorId', n: { $sum: 1 }, lastAt: { $max: '$visitTime' } } }
  ]);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r._id), { count: r.n, lastVisitedAt: r.lastAt });
  }
  return map;
};

const territoryCoverageMonth = async (companyId, territoryId, yyyyMm, tz) => {
  const doctors = await doctorsUnderTerritoryPrefix(companyId, territoryId);
  const ids = doctors.map((d) => d._id);
  const counts = await visitCountsForDoctorsCompanyWide(companyId, ids, yyyyMm, tz);
  let withTarget = 0;
  let metOrExceeded = 0;
  const rows = doctors.map((d) => {
    const tid = String(d._id);
    const stat = counts.get(tid) || {};
    const count = stat.count || 0;
    const lastVisitedAt = stat.lastVisitedAt || null;
    const target =
      d.monthlyVisitTarget != null && Number.isFinite(Number(d.monthlyVisitTarget))
        ? Number(d.monthlyVisitTarget)
        : null;
    if (target != null && target > 0) {
      withTarget += 1;
      if (count >= target) metOrExceeded += 1;
    }
    const gap = target != null ? Math.max(0, target - count) : null;
    const own = mrepOwnership.ownershipForTerritoryRollupRow(d);
    return {
      doctorId: tid,
      doctorName: d.name,
      target,
      actualVisits: count,
      gap,
      lastVisitedAt,
      band: bandForCounts(target, count),
      assignedRepId: d.assignedRepId ? String(d.assignedRepId) : null,
      ownershipKind: own.kind,
      ownershipLabel: own.label,
      coverageStatus: mrepOwnership.coverageBandLabel(target, count),
      metricsDefinition: 'coverageActualV1'
    };
  });
  const coveragePercent = withTarget > 0 ? Math.round((metOrExceeded / withTarget) * 100) : null;
  return {
    month: yyyyMm,
    territoryId: String(territoryId),
    coveragePercent,
    doctorsTracked: withTarget,
    metricsDefinition: 'coverageActualV1',
    doctors: rows
  };
};

/**
 * Additive hints for today's execution payload (doctors on today's route with monthly targets).
 */
const coverageHintsForExecutionDay = async (companyId, employeeId, dateYmd, timeZone, { maxHints = 12 } = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = dateYmd || businessTime.nowInBusinessTime(tz).toISODate();
  const [y, m] = ymd.split('-');
  const yyyyMm = `${y}-${m}`;

  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const items = await PlanItem.find({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true },
    type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
    doctorId: { $ne: null }
  })
    .select('doctorId')
    .lean();

  const doctorIds = [...new Set(items.map((i) => String(i.doctorId)).filter(Boolean))];
  if (!doctorIds.length) return [];

  const oids = doctorIds.map((id) => new mongoose.Types.ObjectId(id));
  const docs = await Doctor.find({ _id: { $in: oids }, companyId }).select('_id name monthlyVisitTarget').lean();

  const counts = await visitCountsForDoctorsInMonth(companyId, employeeId, docs.map((d) => d._id), yyyyMm, tz);

  const hints = [];
  for (const d of docs) {
    const tid = String(d._id);
    const target =
      d.monthlyVisitTarget != null && Number.isFinite(Number(d.monthlyVisitTarget))
        ? Number(d.monthlyVisitTarget)
        : null;
    if (target == null || target <= 0) continue;
    const { count = 0 } = counts.get(tid) || {};
    hints.push({
      doctorId: tid,
      doctorName: d.name,
      monthlyTarget: target,
      visitsSoFarThisMonth: count,
      remaining: Math.max(0, target - count),
      onTrack: count >= target
    });
  }
  hints.sort((a, b) => a.remaining - b.remaining);
  return hints.slice(0, maxHints);
};

module.exports = {
  monthBoundsUtc,
  planItemDateBoundsForMonth,
  ownedDoctorsFilter,
  listOwnedDoctors,
  coverageForRepMonth,
  territoryCoverageMonth,
  coverageHintsForExecutionDay
};
