/**
 * Bulk MRep KPI counter fetch (one query per metric source, not per user).
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const PlanItem = require('../models/PlanItem');
const MedRepTarget = require('../models/MedRepTarget');
const Attendance = require('../models/Attendance');
const businessTime = require('../utils/businessTime');
const { PLAN_ITEM_STATUS, ATTENDANCE_STATUS } = require('../constants/enums');
const coverageService = require('./coverage.service');
const salesAttributionService = require('./salesAttribution.service');
const { computeDashboardNetGrossSalesTpByReps } = require('./tpSalesRollup.service');

const emptyPlanCounters = () => ({
  planItemsTotal: 0,
  visited: 0,
  missed: 0,
  pending: 0,
  outOfOrderVisited: 0,
  unplannedVisited: 0
});

const emptyCoverageCounters = () => ({
  withTarget: 0,
  metOrExceeded: 0
});

const emptyAttendanceCounters = () => ({
  scoreNumerator: 0
});

const emptyTargetCounters = () => ({
  salesTarget: 0,
  achievedSales: 0,
  packsTarget: 0,
  achievedPacks: 0,
  hasTarget: false
});

const emptyOrderCounters = () => ({
  orderCount: 0,
  returnedOrderCount: 0,
  grossRevenue: 0
});

const monthContext = (yyyyMm, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const startLocal = DateTime.fromISO(`${yyyyMm}-01`, { zone }).startOf('month');
  const endLocal = startLocal.endOf('month');
  const fromYmd = startLocal.toISODate();
  const toYmd = endLocal.toISODate();
  const { startDoc, endDoc } = coverageService.planItemDateBoundsForMonth(yyyyMm, tz);
  const tpRange = businessTime.coalesceBusinessDateRangeFromYmd(fromYmd, toYmd, zone);
  const fromUtc = startLocal.startOf('day').toUTC().toJSDate();
  const toUtc = endLocal.endOf('day').toUTC().toJSDate();
  return {
    zone,
    fromYmd,
    toYmd,
    startDoc,
    endDoc,
    tpRange,
    fromUtc,
    toUtc,
    workingDayCount: Math.max(1, endLocal.day)
  };
};

const bulkPlanCounters = async (companyId, repOids, startDoc, endDoc) => {
  const map = new Map();
  if (!repOids.length) return map;

  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rows = await PlanItem.aggregate([
    {
      $match: {
        companyId: cid,
        employeeId: { $in: repOids },
        date: { $gte: startDoc, $lte: endDoc },
        isDeleted: { $ne: true }
      }
    },
    {
      $group: {
        _id: '$employeeId',
        planItemsTotal: { $sum: 1 },
        visited: {
          $sum: { $cond: [{ $eq: ['$status', PLAN_ITEM_STATUS.VISITED] }, 1, 0] }
        },
        missed: {
          $sum: { $cond: [{ $eq: ['$status', PLAN_ITEM_STATUS.MISSED] }, 1, 0] }
        },
        pending: {
          $sum: { $cond: [{ $eq: ['$status', PLAN_ITEM_STATUS.PENDING] }, 1, 0] }
        },
        outOfOrderVisited: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', PLAN_ITEM_STATUS.VISITED] },
                  { $eq: ['$wasOutOfOrder', true] }
                ]
              },
              1,
              0
            ]
          }
        },
        unplannedVisited: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', PLAN_ITEM_STATUS.VISITED] },
                  { $eq: ['$isUnplanned', true] }
                ]
              },
              1,
              0
            ]
          }
        }
      }
    }
  ]);

  for (const r of rows) {
    map.set(String(r._id), {
      planItemsTotal: r.planItemsTotal || 0,
      visited: r.visited || 0,
      missed: r.missed || 0,
      pending: r.pending || 0,
      outOfOrderVisited: r.outOfOrderVisited || 0,
      unplannedVisited: r.unplannedVisited || 0
    });
  }
  return map;
};

const bulkAttendanceCounters = async (companyId, repOids, fromUtc, toUtc) => {
  const map = new Map();
  if (!repOids.length) return map;

  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rows = await Attendance.aggregate([
    {
      $match: {
        companyId: cid,
        employeeId: { $in: repOids },
        date: { $gte: fromUtc, $lte: toUtc },
        isDeleted: { $ne: true }
      }
    },
    {
      $group: {
        _id: '$employeeId',
        present: {
          $sum: { $cond: [{ $eq: ['$status', ATTENDANCE_STATUS.PRESENT] }, 1, 0] }
        },
        halfDay: {
          $sum: { $cond: [{ $eq: ['$status', ATTENDANCE_STATUS.HALF_DAY] }, 1, 0] }
        }
      }
    }
  ]);

  for (const r of rows) {
    map.set(String(r._id), {
      scoreNumerator: (r.present || 0) + (r.halfDay || 0) * 0.5
    });
  }
  return map;
};

const bulkTargetCounters = async (companyId, repOids, yyyyMm) => {
  const map = new Map();
  if (!repOids.length) return map;

  const rows = await MedRepTarget.find({
    companyId,
    medicalRepId: { $in: repOids },
    month: yyyyMm,
    isDeleted: { $ne: true }
  })
    .select('medicalRepId salesTarget achievedSales packsTarget achievedPacks')
    .lean();

  for (const t of rows) {
    map.set(String(t.medicalRepId), {
      salesTarget: t.salesTarget != null ? Number(t.salesTarget) : 0,
      achievedSales: t.achievedSales != null ? Number(t.achievedSales) : 0,
      packsTarget: t.packsTarget != null ? Number(t.packsTarget) : 0,
      achievedPacks: t.achievedPacks != null ? Number(t.achievedPacks) : 0,
      hasTarget: true
    });
  }
  return map;
};

const COVERAGE_BATCH = 16;

const bulkCoverageCounters = async (companyId, repOids, yyyyMm, tz) => {
  const map = new Map();
  if (!repOids.length) return map;

  for (let i = 0; i < repOids.length; i += COVERAGE_BATCH) {
    const chunk = repOids.slice(i, i + COVERAGE_BATCH);
    const parts = await Promise.all(
      chunk.map(async (oid) => {
        const cov = await coverageService.coverageForRepMonth(companyId, oid, yyyyMm, tz);
        let metOrExceeded = 0;
        for (const d of cov.doctors || []) {
          const target =
            d.target != null && Number.isFinite(Number(d.target)) ? Number(d.target) : null;
          if (target != null && target > 0 && (d.actualVisits || 0) >= target) {
            metOrExceeded += 1;
          }
        }
        const withTarget = cov.doctorsTracked || 0;
        return {
          repId: String(oid),
          withTarget,
          metOrExceeded
        };
      })
    );
    for (const p of parts) {
      map.set(p.repId, { withTarget: p.withTarget, metOrExceeded: p.metOrExceeded });
    }
  }
  return map;
};

/**
 * @returns {Promise<Map<string, object>>} per-repId raw counter bundle
 */
const fetchBulkCounters = async (companyId, repOids, yyyyMm, tz) => {
  const ctx = monthContext(yyyyMm, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));

  const [planMap, attendanceMap, targetMap, coverageMap, teamSales, grossTpMap] = await Promise.all([
    bulkPlanCounters(companyId, repOids, ctx.startDoc, ctx.endDoc),
    bulkAttendanceCounters(companyId, repOids, ctx.fromUtc, ctx.toUtc),
    bulkTargetCounters(companyId, repOids, yyyyMm),
    bulkCoverageCounters(companyId, repOids, yyyyMm, tz),
    salesAttributionService.byTeam(companyId, repOids, ctx.fromYmd, ctx.toYmd, tz),
    computeDashboardNetGrossSalesTpByReps(cid, ctx.tpRange, repOids)
  ]);

  const ordersByRep = new Map((teamSales.byRep || []).map((r) => [String(r.medicalRepId), r]));
  const bundle = new Map();

  for (const oid of repOids) {
    const id = String(oid);
    const orders = ordersByRep.get(id);
    bundle.set(id, {
      plan: planMap.get(id) || emptyPlanCounters(),
      coverage: coverageMap.get(id) || emptyCoverageCounters(),
      attendance: attendanceMap.get(id) || emptyAttendanceCounters(),
      target: targetMap.get(id) || emptyTargetCounters(),
      orders: orders
        ? {
            orderCount: orders.orderCount || 0,
            returnedOrderCount: orders.returnedOrderCount || 0,
            grossRevenue: orders.grossRevenue || 0
          }
        : emptyOrderCounters(),
      grossSalesTp: grossTpMap.get(id) ?? 0,
      workingDayCount: ctx.workingDayCount
    });
  }

  return bundle;
};

module.exports = {
  monthContext,
  fetchBulkCounters,
  emptyPlanCounters,
  emptyCoverageCounters,
  emptyAttendanceCounters,
  emptyTargetCounters,
  emptyOrderCounters
};
