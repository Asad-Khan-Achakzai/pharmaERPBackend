/**
 * In-memory hierarchy maps and KPI roll-up from bulk per-user counters.
 */
const {
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE,
  DEFAULT_ADMIN_CODE
} = require('../constants/rbac');

const MANAGER_ROLE_CODES = new Set([DEFAULT_ASM_CODE, DEFAULT_RM_CODE, DEFAULT_ADMIN_CODE]);

const isMedicalRepRole = (roleCode) => roleCode === DEFAULT_MEDICAL_REP_CODE;

/**
 * Managers on the ladder (ASM/RM/Admin) or custom roles with reports in scope get team roll-up.
 */
const userHasTeamRollup = (roleCode, descendantCountInScope) => {
  if (isMedicalRepRole(roleCode)) return false;
  if (roleCode && MANAGER_ROLE_CODES.has(roleCode)) return true;
  return descendantCountInScope > 0;
};

const sumCounters = (userIds, countersByUser) => {
  const acc = {
    plan: {
      planItemsTotal: 0,
      visited: 0,
      missed: 0,
      pending: 0,
      outOfOrderVisited: 0,
      unplannedVisited: 0
    },
    coverage: { withTarget: 0, metOrExceeded: 0 },
    attendance: { scoreNumerator: 0, headcount: 0 },
    target: {
      salesTarget: 0,
      achievedSales: 0,
      packsTarget: 0,
      achievedPacks: 0,
      hasTarget: false
    },
    orders: { orderCount: 0, returnedOrderCount: 0, grossRevenue: 0 },
    grossSalesTp: 0,
    workingDayCount: 0
  };

  for (const uid of userIds) {
    const c = countersByUser.get(uid);
    if (!c) continue;
    acc.plan.planItemsTotal += c.plan.planItemsTotal;
    acc.plan.visited += c.plan.visited;
    acc.plan.missed += c.plan.missed;
    acc.plan.pending += c.plan.pending;
    acc.plan.outOfOrderVisited += c.plan.outOfOrderVisited;
    acc.plan.unplannedVisited += c.plan.unplannedVisited;
    acc.coverage.withTarget += c.coverage.withTarget;
    acc.coverage.metOrExceeded += c.coverage.metOrExceeded;
    acc.attendance.scoreNumerator += c.attendance.scoreNumerator;
    acc.attendance.headcount += 1;
    if (c.target.hasTarget) {
      acc.target.hasTarget = true;
      acc.target.salesTarget += c.target.salesTarget;
      acc.target.achievedSales += c.target.achievedSales;
      acc.target.packsTarget += c.target.packsTarget;
      acc.target.achievedPacks += c.target.achievedPacks;
    }
    acc.orders.orderCount += c.orders.orderCount;
    acc.orders.returnedOrderCount += c.orders.returnedOrderCount;
    acc.orders.grossRevenue += c.orders.grossRevenue;
    acc.grossSalesTp += c.grossSalesTp;
    acc.workingDayCount = c.workingDayCount;
  }

  return acc;
};

const metricsFromAggregatedCounters = (acc) => {
  const { plan, coverage, attendance, target, orders, grossSalesTp, workingDayCount } = acc;
  const totalClosed = plan.visited + plan.missed;
  const visitCompletionPercent = totalClosed ? Math.round((plan.visited / totalClosed) * 100) : null;
  const adherencePercent =
    plan.visited > 0
      ? Math.max(0, Math.round(((plan.visited - plan.outOfOrderVisited) / plan.visited) * 100))
      : null;
  const unplannedRatio =
    plan.visited > 0 ? Math.round((plan.unplannedVisited / plan.visited) * 100) : null;
  const coveragePercent =
    coverage.withTarget > 0 ? Math.round((coverage.metOrExceeded / coverage.withTarget) * 100) : null;

  const salesTarget = target.hasTarget ? target.salesTarget : null;
  const achievedSales = target.hasTarget ? target.achievedSales : null;
  const salesAchievementPercent =
    salesTarget && salesTarget > 0 && achievedSales != null
      ? Math.round((achievedSales / salesTarget) * 100)
      : null;

  const wd = workingDayCount || 1;
  const attendanceScorePercent =
    attendance.headcount > 0
      ? Math.min(
          100,
          Math.round((attendance.scoreNumerator / (wd * attendance.headcount)) * 100)
        )
      : null;

  return {
    coverage: {
      coveragePercent,
      doctorsTracked: coverage.withTarget,
      metricsDefinition: 'coverageActualV1'
    },
    planExecution: {
      planItemsTotal: plan.planItemsTotal,
      visited: plan.visited,
      missed: plan.missed,
      pending: plan.pending,
      outOfOrderVisited: plan.outOfOrderVisited,
      unplannedVisited: plan.unplannedVisited,
      visitCompletionPercent,
      adherencePercent,
      unplannedRatio
    },
    target: target.hasTarget
      ? {
          salesTarget,
          achievedSales,
          packsTarget: target.packsTarget,
          achievedPacks: target.achievedPacks,
          salesAchievementPercent
        }
      : {
          salesTarget: null,
          achievedSales: null,
          packsTarget: null,
          achievedPacks: null,
          salesAchievementPercent: null
        },
    ordersInPeriod: {
      orderCount: orders.orderCount,
      returnedOrderCount: orders.returnedOrderCount,
      grossRevenue: Math.round(orders.grossRevenue * 100) / 100
    },
    totalGrossSalesTp: grossSalesTp,
    attendanceScorePercent
  };
};

const metricsFromUserCounters = (counters) => {
  if (!counters) return null;
  return metricsFromAggregatedCounters({
    plan: counters.plan,
    coverage: counters.coverage,
    attendance: { scoreNumerator: counters.attendance.scoreNumerator, headcount: 1 },
    target: counters.target,
    orders: counters.orders,
    grossSalesTp: counters.grossSalesTp,
    workingDayCount: counters.workingDayCount
  });
};

/**
 * Build scoped hierarchy helpers from users visible in the overview.
 * @param {Array<{ _id: unknown, managerId?: unknown, roleId?: { code?: string, name?: string } | null }>} users
 * @param {Set<string>} scopeIdSet
 */
const buildScopeHierarchy = (users, scopeIdSet) => {
  const nodes = new Map();
  for (const u of users) {
    const id = String(u._id);
    nodes.set(id, {
      id,
      managerId:
        u.managerId && scopeIdSet.has(String(u.managerId)) ? String(u.managerId) : null,
      roleCode: u.roleId?.code ?? null,
      roleName: u.roleId?.name ?? null,
      children: []
    });
  }

  for (const node of nodes.values()) {
    if (node.managerId && nodes.has(node.managerId)) {
      nodes.get(node.managerId).children.push(node.id);
    }
  }

  const subtreeMemo = new Map();
  const collectSubtree = (uid) => {
    if (subtreeMemo.has(uid)) return subtreeMemo.get(uid);
    const ids = [uid];
    const node = nodes.get(uid);
    if (node) {
      for (const childId of node.children) {
        for (const d of collectSubtree(childId)) {
          if (!ids.includes(d)) ids.push(d);
        }
      }
    }
    subtreeMemo.set(uid, ids);
    return ids;
  };

  for (const id of nodes.keys()) {
    collectSubtree(id);
  }

  const teamSize = (uid) => {
    const sub = subtreeMemo.get(uid) || [uid];
    return Math.max(0, sub.length - 1);
  };

  return { nodes, subtreeMemo, teamSize, collectSubtree };
};

const rollupMetricsForUserIds = (userIds, countersByUser) =>
  metricsFromAggregatedCounters(sumCounters(userIds, countersByUser));

module.exports = {
  MANAGER_ROLE_CODES,
  isMedicalRepRole,
  userHasTeamRollup,
  buildScopeHierarchy,
  metricsFromUserCounters,
  rollupMetricsForUserIds,
  metricsFromAggregatedCounters,
  sumCounters
};
