/**
 * Aggregates existing services for GET /dashboard/home (no duplicated business rules).
 * Feature flag: ENABLE_NEW_DASHBOARD — controller should reject when off.
 */
const reportService = require('./report.service');
const planItemService = require('./planItem.service');
const targetService = require('./target.service');
const attendanceService = require('./attendance.service');
const supplierService = require('./supplier.service');
const { userHasPermission } = require('../utils/effectivePermissions');

const currentYyyyMm = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const resolveMode = (user) => {
  const companyWide = userHasPermission(user, 'admin.access');
  const weekly = userHasPermission(user, 'weeklyPlans.view');
  if (companyWide && weekly) return 'hybrid';
  if (companyWide) return 'monitoring';
  return 'execution';
};

/**
 * @param {string} companyId
 * @param {object} user - req.user (with userId, permissions, role)
 * @param {object} [query] - validated `from` / `to` (YYYY-MM-DD) for dashboard KPIs
 * @returns {Promise<object>}
 */
const getHome = async (companyId, user, query = {}) => {
  const companyWideKpis = userHasPermission(user, 'admin.access');
  const weekly = userHasPermission(user, 'weeklyPlans.view');
  const canTargets = userHasPermission(user, 'targets.view');
  const attTeam = userHasPermission(user, 'attendance.view');
  const attMine = userHasPermission(user, 'attendance.mark');
  const sup = userHasPermission(user, 'suppliers.view');

  const repId = user.userId;
  const tasks = [];
  const labels = [];

  const dashOpts = {};
  if (query.from && query.to) {
    dashOpts.from = query.from;
    dashOpts.to = query.to;
  }
  if (companyWideKpis) {
    tasks.push(() => reportService.dashboard(companyId, dashOpts));
    labels.push('kpis');
  } else {
    tasks.push(() =>
      reportService.dashboard(companyId, {
        ...dashOpts,
        restrictToRepId: repId
      })
    );
    labels.push('kpis');
  }

  if (weekly) {
    tasks.push(() => planItemService.listTodayPending(companyId, repId, undefined));
    labels.push('pendingPlanItems');
  } else {
    tasks.push(() => Promise.resolve([]));
    labels.push('pendingPlanItems');
  }

  if (canTargets) {
    tasks.push(() => targetService.getByRep(companyId, repId));
    labels.push('targetRows');
  } else {
    tasks.push(() => Promise.resolve(null));
    labels.push('targetRows');
  }

  if (attTeam) {
    tasks.push(() => attendanceService.listToday(companyId));
    labels.push('teamAtt');
  } else {
    tasks.push(() => Promise.resolve(null));
    labels.push('teamAtt');
  }

  if (attMine) {
    tasks.push(() => attendanceService.getMeToday(companyId, repId));
    labels.push('meAtt');
  } else {
    tasks.push(() => Promise.resolve(null));
    labels.push('meAtt');
  }

  if (sup) {
    tasks.push(() =>
      Promise.all([
        supplierService.recentPayments(companyId, { limit: 8 }),
        supplierService.supplierBalances(companyId)
      ]).then(([recent, balances]) => ({ recent, balances }))
    );
    labels.push('suppliers');
  } else {
    tasks.push(() => Promise.resolve(null));
    labels.push('suppliers');
  }

  const settled = await Promise.allSettled(tasks.map((fn) => fn()));
  const warnings = [];
  const byLabel = {};
  settled.forEach((s, i) => {
    const key = labels[i];
    if (s.status === 'fulfilled') {
      byLabel[key] = s.value;
    } else {
      warnings.push({ section: key, message: s.reason?.message || 'failed' });
      byLabel[key] = key === 'pendingPlanItems' ? [] : null;
    }
  });

  const yyyymm = currentYyyyMm();
  let targetCurrent = null;
  const targetRowsRaw = byLabel.targetRows;
  if (targetRowsRaw && Array.isArray(targetRowsRaw) && canTargets) {
    const rows = targetRowsRaw.map((d) => (d && typeof d.toObject === 'function' ? d.toObject() : d));
    targetCurrent = rows.find((t) => t.month === yyyymm) || rows[0] || null;
  }

  const mode = resolveMode(user);

  return {
    mode,
    features: {
      canSeeCompanyFinancials: companyWideKpis,
      showExecutionPanel: weekly
    },
    kpis: byLabel.kpis,
    today: {
      /** Alias: same as pendingPlanItems for clients that expect `visits` */
      visits: byLabel.pendingPlanItems || [],
      pendingPlanItems: byLabel.pendingPlanItems || []
    },
    targets: {
      currentMonth: targetCurrent,
      allRows:
        canTargets && Array.isArray(targetRowsRaw) && targetRowsRaw.length
          ? targetRowsRaw.map((d) => (d && typeof d.toObject === 'function' ? d.toObject() : d)).slice(0, 12)
          : []
    },
    attendance: {
      team: byLabel.teamAtt,
      me: byLabel.meAtt
    },
    suppliers:
      byLabel.suppliers && byLabel.suppliers.recent
        ? {
            recentPayments: byLabel.suppliers.recent,
            balances: byLabel.suppliers.balances
          }
        : null,
    charts: {
      /** Profit/cost + inventory client charts still use existing report endpoints to avoid large payloads. */
      deferred: true
    },
    meta: {
      source: 'dashboard.home',
      version: 1,
      warnings: warnings.length ? warnings : undefined
    }
  };
};

module.exports = {
  getHome
};
