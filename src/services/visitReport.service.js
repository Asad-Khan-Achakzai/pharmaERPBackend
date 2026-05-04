const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const VisitLog = require('../models/VisitLog');
const { PLAN_ITEM_STATUS } = require('../constants/enums');
const ApiError = require('../utils/ApiError');
const { dateDocFromPstYmd, endOfPstDayJsDate } = require('../utils/attendancePst');

const visitSummary = async (companyId, query) => {
  const { weekStart, weekEnd, employeeId } = query;
  if (!weekStart || !weekEnd) {
    throw new ApiError(400, 'weekStart and weekEnd (YYYY-MM-DD) are required');
  }
  const ws = String(weekStart).slice(0, 10);
  const we = String(weekEnd).slice(0, 10);
  const start = dateDocFromPstYmd(ws);
  const endDayStart = dateDocFromPstYmd(we);
  const endVisitTime = endOfPstDayJsDate(we);

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    date: { $gte: start, $lte: endDayStart },
    isDeleted: { $ne: true }
  };
  if (employeeId) match.employeeId = new mongoose.Types.ObjectId(employeeId);

  const byStatus = await PlanItem.aggregate([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const counts = { PENDING: 0, VISITED: 0, MISSED: 0 };
  for (const row of byStatus) {
    if (row._id && counts[row._id] !== undefined) counts[row._id] = row.count;
  }

  const totalPlanned = counts.PENDING + counts.VISITED + counts.MISSED;
  const totalVisited = counts.VISITED;
  const totalMissed = counts.MISSED;
  const completionRate =
    totalPlanned > 0 ? Math.round((totalVisited / totalPlanned) * 10000) / 100 : 0;

  const visitMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    planItemId: null,
    visitTime: { $gte: start, $lte: endVisitTime },
    isDeleted: { $ne: true }
  };
  if (employeeId) visitMatch.employeeId = new mongoose.Types.ObjectId(employeeId);

  const unplannedMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    date: { $gte: start, $lte: endDayStart },
    isUnplanned: true,
    status: PLAN_ITEM_STATUS.VISITED,
    isDeleted: { $ne: true }
  };
  if (employeeId) unplannedMatch.employeeId = new mongoose.Types.ObjectId(employeeId);

  const unplannedPlanItems = await PlanItem.countDocuments(unplannedMatch);

  const legacyOrphanLogs = await VisitLog.countDocuments(visitMatch);

  const unplannedVisits = unplannedPlanItems + legacyOrphanLogs;

  return {
    weekStart: ws,
    weekEnd: we,
    totalPlanned,
    totalVisited,
    totalMissed,
    totalPending: counts.PENDING,
    completionRate,
    unplannedVisits
  };
};

/**
 * Per-employee breakdown: visits per day, doctor coverage, unplanned count.
 */
const visitByEmployee = async (companyId, query) => {
  const { weekStart, weekEnd } = query;
  if (!weekStart || !weekEnd) {
    throw new ApiError(400, 'weekStart and weekEnd (YYYY-MM-DD) are required');
  }
  const ws = String(weekStart).slice(0, 10);
  const we = String(weekEnd).slice(0, 10);
  const start = dateDocFromPstYmd(ws);
  const endDayStart = dateDocFromPstYmd(we);
  const endVisitTime = endOfPstDayJsDate(we);

  const planMatch = {
    companyId: new mongoose.Types.ObjectId(companyId),
    date: { $gte: start, $lte: endDayStart },
    isDeleted: { $ne: true }
  };

  const perDay = await PlanItem.aggregate([
    { $match: planMatch },
    {
      $group: {
        _id: { employeeId: '$employeeId', date: '$date', status: '$status' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.date': 1 } }
  ]);

  const doctorCoverage = await PlanItem.aggregate([
    {
      $match: {
        ...planMatch,
        type: 'DOCTOR_VISIT',
        doctorId: { $ne: null },
        status: PLAN_ITEM_STATUS.VISITED
      }
    },
    {
      $group: {
        _id: { employeeId: '$employeeId', doctorId: '$doctorId' },
        visits: { $sum: 1 }
      }
    }
  ]);

  const unplannedByEmp = await PlanItem.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        date: { $gte: start, $lte: endDayStart },
        isUnplanned: true,
        status: PLAN_ITEM_STATUS.VISITED,
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$employeeId', unplanned: { $sum: 1 } } }
  ]);

  const legacyUnplannedByEmp = await VisitLog.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        planItemId: null,
        visitTime: { $gte: start, $lte: endVisitTime },
        isDeleted: { $ne: true }
      }
    },
    { $group: { _id: '$employeeId', unplanned: { $sum: 1 } } }
  ]);

  const unplannedMap = new Map();
  for (const row of [...unplannedByEmp, ...legacyUnplannedByEmp]) {
    const k = String(row._id);
    unplannedMap.set(k, (unplannedMap.get(k) || 0) + row.unplanned);
  }
  const unplannedByEmployee = [...unplannedMap.entries()].map(([empId, count]) => ({
    _id: empId,
    unplanned: count
  }));

  return {
    weekStart: ws,
    weekEnd: we,
    perDay,
    doctorCoverage,
    unplannedByEmployee
  };
};

module.exports = { visitSummary, visitByEmployee };
