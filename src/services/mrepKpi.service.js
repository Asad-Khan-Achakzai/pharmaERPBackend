/**
 * Composes MRep KPI slices for one rep × month (Phase 3 — read-side).
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const PlanItem = require('../models/PlanItem');
const MedRepTarget = require('../models/MedRepTarget');
const Attendance = require('../models/Attendance');
const businessTime = require('../utils/businessTime');
const { PLAN_ITEM_STATUS } = require('../constants/enums');
const { ATTENDANCE_STATUS } = require('../constants/enums');
const coverageService = require('./coverage.service');
const salesAttributionService = require('./salesAttribution.service');
const { computeDashboardNetGrossSalesTp } = require('./tpSalesRollup.service');

const monthFirstLastYmd = (yyyyMm, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  return { fromYmd: startLocal.toISODate(), toYmd: endLocal.toISODate(), workingDayCount: endLocal.day };
};

const planItemExecutionStats = async (companyId, repId, yyyyMm, tz) => {
  const { startDoc, endDoc } = coverageService.planItemDateBoundsForMonth(yyyyMm, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(repId));

  const items = await PlanItem.find({
    companyId: cid,
    employeeId: rid,
    date: { $gte: startDoc, $lte: endDoc },
    isDeleted: { $ne: true }
  })
    .select('status wasOutOfOrder isUnplanned')
    .lean();

  let visited = 0;
  let missed = 0;
  let pending = 0;
  let outOfOrder = 0;
  let unplannedVisited = 0;
  for (const it of items) {
    if (it.status === PLAN_ITEM_STATUS.VISITED) {
      visited += 1;
      if (it.wasOutOfOrder) outOfOrder += 1;
      if (it.isUnplanned) unplannedVisited += 1;
    } else if (it.status === PLAN_ITEM_STATUS.MISSED) missed += 1;
    else if (it.status === PLAN_ITEM_STATUS.PENDING) pending += 1;
  }
  const totalClosed = visited + missed;
  const visitCompletionPercent = totalClosed ? Math.round((visited / totalClosed) * 100) : null;
  const adherencePercent = visited > 0 ? Math.max(0, Math.round(((visited - outOfOrder) / visited) * 100)) : null;
  const unplannedRatio = visited > 0 ? Math.round((unplannedVisited / visited) * 100) : null;

  return {
    planItemsTotal: items.length,
    visited,
    missed,
    pending,
    outOfOrderVisited: outOfOrder,
    unplannedVisited,
    visitCompletionPercent,
    adherencePercent,
    unplannedRatio
  };
};

const attendanceScorePercent = async (companyId, repId, yyyyMm, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  const workingDayCount = Math.max(1, endLocal.day);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rid = new mongoose.Types.ObjectId(String(repId));
  const fromUtc = startLocal.startOf('day').toUTC().toJSDate();
  const toUtc = endLocal.endOf('day').toUTC().toJSDate();

  const rows = await Attendance.find({
    companyId: cid,
    employeeId: rid,
    date: { $gte: fromUtc, $lte: toUtc },
    isDeleted: { $ne: true }
  })
    .select('status')
    .lean();

  let score = 0;
  for (const r of rows) {
    if (r.status === ATTENDANCE_STATUS.PRESENT) score += 1;
    else if (r.status === ATTENDANCE_STATUS.HALF_DAY) score += 0.5;
  }
  return Math.min(100, Math.round((score / workingDayCount) * 100));
};

const monthlyRowForRep = async (companyId, repId, yyyyMm, tz) => {
  const { fromYmd, toYmd } = monthFirstLastYmd(yyyyMm, tz);
  const zone = businessTime.requireCompanyIanaZone(tz);
  const tpRange = businessTime.coalesceBusinessDateRangeFromYmd(fromYmd, toYmd, zone);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const repOid = new mongoose.Types.ObjectId(String(repId));

  const [coverage, planStats, target, sales, attendancePct, totalGrossSalesTp] = await Promise.all([
    coverageService.coverageForRepMonth(companyId, repId, yyyyMm, tz),
    planItemExecutionStats(companyId, repId, yyyyMm, tz),
    MedRepTarget.findOne({
      companyId,
      medicalRepId: repId,
      month: yyyyMm,
      isDeleted: { $ne: true }
    })
      .select('salesTarget achievedSales packsTarget achievedPacks')
      .lean(),
    salesAttributionService.byRep(companyId, repId, fromYmd, toYmd, tz),
    attendanceScorePercent(companyId, repId, yyyyMm, tz),
    computeDashboardNetGrossSalesTp(cid, tpRange, repOid)
  ]);

  const salesTarget = target?.salesTarget != null ? Number(target.salesTarget) : null;
  const achievedSales = target?.achievedSales != null ? Number(target.achievedSales) : null;
  const salesAchievementPercent =
    salesTarget && salesTarget > 0 && achievedSales != null
      ? Math.round((achievedSales / salesTarget) * 100)
      : null;

  return {
    repId: String(repId),
    month: yyyyMm,
    coverage,
    planExecution: planStats,
    target: target
      ? {
          salesTarget,
          achievedSales,
          packsTarget: target.packsTarget != null ? Number(target.packsTarget) : null,
          achievedPacks: target.achievedPacks != null ? Number(target.achievedPacks) : null,
          salesAchievementPercent
        }
      : {
          salesTarget: null,
          achievedSales: null,
          packsTarget: null,
          achievedPacks: null,
          salesAchievementPercent: null
        },
    ordersInPeriod: sales,
    totalGrossSalesTp,
    attendanceScorePercent: attendancePct
  };
};

module.exports = {
  monthlyRowForRep,
  planItemExecutionStats,
  monthFirstLastYmd
};
