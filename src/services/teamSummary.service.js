/**
 * Team summary aggregator (Phase 2C).
 *
 * Produces a manager-facing rollup of "what is my team doing today/this week?":
 *   - Reporting subtree size (active reps)
 *   - Today's visits visited / planned / missed / pending across the subtree
 *   - Out-of-sequence + unplanned counts (deviation signal)
 *   - Pending weekly-plan approvals waiting on the manager
 *
 * No new business rules: visits/coverage are read directly from PlanItem (the same
 * source `planItem.service.buildTodayExecution` uses for a single rep). Aggregation
 * is a single grouped count, so cost stays proportional to subtree size, not company size.
 */
const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const WeeklyPlan = require('../models/WeeklyPlan');
const User = require('../models/User');
const businessTime = require('../utils/businessTime');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { PLAN_ITEM_STATUS, WEEKLY_PLAN_STATUS } = require('../constants/enums');

const toObjectId = (v) => new mongoose.Types.ObjectId(String(v));

/**
 * @param {string} companyId
 * @param {object} reqUser  - req.user
 * @param {string} timeZone - company IANA TZ
 * @returns {Promise<object>}
 */
const getTeamSummary = async (companyId, reqUser, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const isAdmin = (reqUser?.permissions || []).includes('admin.access');

  let subtreeUserIds;
  if (isAdmin) {
    /** Admins have implicit company-wide visibility — we still need a list of active reps for the size signal. */
    subtreeUserIds = (
      await User.find({ companyId, isActive: true, isDeleted: { $ne: true } })
        .select('_id')
        .lean()
    ).map((u) => u._id);
  } else {
    subtreeUserIds = await resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: true });
  }

  if (!subtreeUserIds.length) {
    return {
      teamSize: 0,
      activeReps: 0,
      today: { date: businessTime.nowInBusinessTime(tz).toISODate(), visited: 0, missed: 0, pending: 0, total: 0, coveragePercent: 0, outOfSequenceCount: 0, unplannedCount: 0 },
      pendingApprovalsCount: 0
    };
  }

  /** Active rep filter (for the team-size pill — "X active of Y total"). */
  const activeRepCount = await User.countDocuments({
    _id: { $in: subtreeUserIds },
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });

  const todayYmd = businessTime.nowInBusinessTime(tz).toISODate();
  const todayDate = businessTime.businessDayStartUtc(todayYmd, tz);

  const grouped = await PlanItem.aggregate([
    {
      $match: {
        companyId: toObjectId(companyId),
        employeeId: { $in: subtreeUserIds.map(toObjectId) },
        date: todayDate,
        isDeleted: { $ne: true }
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        outOfSequenceCount: { $sum: { $cond: [{ $eq: ['$wasOutOfOrder', true] }, 1, 0] } },
        unplannedCount: { $sum: { $cond: [{ $eq: ['$isUnplanned', true] }, 1, 0] } }
      }
    }
  ]);

  let visited = 0;
  let missed = 0;
  let pending = 0;
  let outOfSequenceCount = 0;
  let unplannedCount = 0;
  for (const row of grouped) {
    const c = Number(row.count) || 0;
    if (row._id === PLAN_ITEM_STATUS.VISITED) visited += c;
    else if (row._id === PLAN_ITEM_STATUS.MISSED) missed += c;
    else if (row._id === PLAN_ITEM_STATUS.PENDING) pending += c;
    outOfSequenceCount += Number(row.outOfSequenceCount) || 0;
    unplannedCount += Number(row.unplannedCount) || 0;
  }
  const total = visited + missed + pending;
  const coveragePercent = total ? Math.round((visited / total) * 100) : 0;

  /** Plans waiting on someone in the manager's chain. */
  const pendingApprovalsFilter = {
    companyId,
    status: WEEKLY_PLAN_STATUS.SUBMITTED,
    isDeleted: { $ne: true }
  };
  if (!isAdmin) {
    /** Exclude self — RMs review reports' plans, not their own. */
    pendingApprovalsFilter.medicalRepId = {
      $in: subtreeUserIds.filter((id) => String(id) !== String(reqUser.userId))
    };
  }
  const pendingApprovalsCount = await WeeklyPlan.countDocuments(pendingApprovalsFilter);

  return {
    teamSize: subtreeUserIds.length,
    activeReps: activeRepCount,
    today: {
      date: todayYmd,
      visited,
      missed,
      pending,
      total,
      coveragePercent,
      outOfSequenceCount,
      unplannedCount
    },
    pendingApprovalsCount
  };
};

module.exports = { getTeamSummary };
