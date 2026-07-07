/**
 * HTTP-facing MRep report orchestration (scope checks + batched rows).
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const User = require('../models/User');
const Territory = require('../models/Territory');
const ApiError = require('../utils/ApiError');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { userHasPermission, userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { DEFAULT_MEDICAL_REP_CODE } = require('../constants/rbac');
const coverageService = require('./coverage.service');
const mrepKpiService = require('./mrepKpi.service');
const { fetchBulkCounters } = require('./mrepKpiBulk.service');
const {
  buildScopeHierarchy,
  metricsFromUserCounters,
  rollupMetricsForUserIds,
  userHasTeamRollup
} = require('./mrepHierarchyRollup.service');
const businessTime = require('../utils/businessTime');

const {
  buildAllowedTerritoryIdSet,
  assertTerritoryCompareParentAccess
} = require('../utils/territoryCompareScope.util');

const assertCanViewRep = async (companyId, viewerUser, repId) => {
  const rep = await User.findOne({
    _id: repId,
    companyId,
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('_id')
    .lean();
  if (!rep) throw new ApiError(404, 'Representative not found or inactive');

  const viewerUserId = viewerUser.userId;
  if (String(viewerUserId) === String(repId)) return;

  if (userHasTenantWideAccess(viewerUser)) {
    return;
  }

  const subtree = await resolveSubtreeUserIds(companyId, viewerUserId, {
    includeSelf: true,
    activeOnly: true
  });
  const ok = subtree.some((id) => String(id) === String(repId));
  if (!ok) throw new ApiError(403, 'You cannot view this representative’s performance data');
};

const resolveOverviewRepIds = async (companyId, viewerUser, explicitRepId) => {
  const viewerUserId = viewerUser.userId;
  if (explicitRepId) {
    await assertCanViewRep(companyId, viewerUser, explicitRepId);
    return [new mongoose.Types.ObjectId(String(explicitRepId))];
  }

  if (userHasTenantWideAccess(viewerUser)) {
    const docs = await User.find({ companyId, isDeleted: { $ne: true }, isActive: true })
      .select('_id')
      .sort({ name: 1 })
      .lean();
    return docs.map((d) => d._id);
  }

  if (userHasPermission(viewerUser, 'team.viewAllReports')) {
    let ids = await resolveSubtreeUserIds(companyId, viewerUserId, {
      includeSelf: true,
      activeOnly: true
    });
    if (!ids.length) {
      const selfActive = await User.findOne({
        _id: viewerUserId,
        companyId,
        isDeleted: { $ne: true },
        isActive: true
      })
        .select('_id')
        .lean();
      ids = selfActive ? [selfActive._id] : [];
    }
    return ids;
  }

  return [new mongoose.Types.ObjectId(String(viewerUserId))];
};

const attachRowIdentity = (metrics, repId, yyyyMm, userMeta) => ({
  repId,
  month: yyyyMm,
  ...metrics,
  name: userMeta?.name ?? null,
  email: userMeta?.email ?? null,
  employeeCode: userMeta?.employeeCode ?? null,
  roleCode: userMeta?.roleCode ?? null,
  roleName: userMeta?.roleName ?? null,
  managerId: userMeta?.managerId ?? null
});

const monthlyOverview = async (companyId, viewerUser, yyyyMm, timeZone, { repId: explicitRepId } = {}) => {
  const repOids = await resolveOverviewRepIds(companyId, viewerUser, explicitRepId);

  let counterRepOids = repOids;
  if (explicitRepId && repOids.length === 1) {
    counterRepOids = await resolveSubtreeUserIds(companyId, explicitRepId, {
      includeSelf: true,
      activeOnly: true
    });
    if (!counterRepOids.length) counterRepOids = repOids;
  }

  const counterScopeSet = new Set(counterRepOids.map((id) => String(id)));

  const users = await User.find({
    _id: { $in: repOids },
    companyId,
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('name email employeeCode managerId roleId')
    .populate('roleId', 'code name')
    .sort({ name: 1 })
    .lean();

  if (!users.length) {
    return {
      month: yyyyMm,
      metricsVersion: 'mrepMonthlyOverviewV2',
      scopeSummary: null,
      reps: []
    };
  }

  const hierarchyUsers = await User.find({
    _id: { $in: counterRepOids },
    companyId,
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('_id managerId roleId')
    .populate('roleId', 'code name')
    .lean();

  const { subtreeMemo, teamSize } = buildScopeHierarchy(hierarchyUsers, counterScopeSet);
  const countersByUser = await fetchBulkCounters(companyId, counterRepOids, yyyyMm, timeZone);

  const scopeUserIds = explicitRepId
    ? (() => {
        const id = String(explicitRepId);
        const u = users.find((x) => String(x._id) === id);
        const roleCode = u?.roleId?.code ?? null;
        const descendants = teamSize(id);
        if (userHasTeamRollup(roleCode, descendants)) {
          return subtreeMemo.get(id) || [id];
        }
        return [id];
      })()
    : repOids.map((id) => String(id));

  const scopeMetrics = rollupMetricsForUserIds(scopeUserIds, countersByUser);

  const reps = users.map((u) => {
    const repId = String(u._id);
    const roleCode = u.roleId?.code ?? null;
    const descendants = teamSize(repId);
    const hasTeamRollup = userHasTeamRollup(roleCode, descendants);
    const personalBundle = countersByUser.get(repId);
    const personalMetrics = metricsFromUserCounters(personalBundle);

    const userMeta = {
      name: u.name,
      email: u.email,
      employeeCode: u.employeeCode,
      roleCode,
      roleName: u.roleId?.name ?? null,
      managerId: u.managerId ? String(u.managerId) : null
    };

    if (!hasTeamRollup) {
      return {
        ...attachRowIdentity(personalMetrics, repId, yyyyMm, userMeta),
        displayMode: 'individual',
        hasTeamRollup: false,
        teamSize: null,
        personalMetrics: null
      };
    }

    const subtreeIds = subtreeMemo.get(repId) || [repId];
    const teamMetrics = rollupMetricsForUserIds(subtreeIds, countersByUser);

    return {
      ...attachRowIdentity(teamMetrics, repId, yyyyMm, userMeta),
      displayMode: 'teamRollup',
      hasTeamRollup: true,
      teamSize: descendants,
      personalMetrics: {
        coverage: personalMetrics.coverage,
        planExecution: personalMetrics.planExecution,
        target: personalMetrics.target,
        ordersInPeriod: personalMetrics.ordersInPeriod,
        totalGrossSalesTp: personalMetrics.totalGrossSalesTp,
        attendanceScorePercent: personalMetrics.attendanceScorePercent
      }
    };
  });

  return {
    month: yyyyMm,
    metricsVersion: 'mrepMonthlyOverviewV2',
    scopeSummary: {
      ...scopeMetrics,
      teamSize: scopeUserIds.length,
      label: explicitRepId ? 'filtered' : 'viewerScope'
    },
    reps
  };
};

const doctorCoverageForRep = async (companyId, viewerUser, repId, yyyyMm, timeZone) => {
  await assertCanViewRep(companyId, viewerUser, repId);
  return coverageService.coverageForRepMonth(companyId, repId, yyyyMm, timeZone);
};

const territoryCoverage = async (companyId, territoryId, yyyyMm, timeZone) => {
  return coverageService.territoryCoverageMonth(companyId, territoryId, yyyyMm, timeZone);
};

const deviationSummary = async (companyId, viewerUser, yyyyMm, timeZone, { repId: explicitRepId } = {}) => {
  const repOids = await resolveOverviewRepIds(companyId, viewerUser, explicitRepId);
  const users = await User.find({
    _id: { $in: repOids },
    companyId,
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('name email employeeCode')
    .lean();
  const byId = Object.fromEntries(users.map((u) => [String(u._id), u]));

  const reps = await Promise.all(
    repOids.map(async (oid) => {
      const stats = await mrepKpiService.planItemExecutionStats(companyId, oid, yyyyMm, timeZone);
      const rid = String(oid);
      return {
        repId: rid,
        name: byId[rid]?.name ?? null,
        email: byId[rid]?.email ?? null,
        employeeCode: byId[rid]?.employeeCode ?? null,
        planExecution: stats
      };
    })
  );
  return { month: yyyyMm, metricsVersion: 'planExecutionV1', reps };
};

const rankings = async (companyId, viewerUser, yyyyMm, timeZone, { repId: explicitRepId } = {}) => {
  const data = await monthlyOverview(companyId, viewerUser, yyyyMm, timeZone, {
    repId: explicitRepId
  });
  const rankingsRows = data.reps
    .filter((r) => r.roleCode === DEFAULT_MEDICAL_REP_CODE)
    .map((r) => {
      const individual = r.personalMetrics || r;
      return {
        repId: r.repId,
        name: r.name,
        employeeCode: r.employeeCode,
        coveragePercent: individual.coverage?.coveragePercent ?? null,
        visitCompletionPercent: individual.planExecution?.visitCompletionPercent ?? null,
        adherencePercent: individual.planExecution?.adherencePercent ?? null,
        unplannedRatio: individual.planExecution?.unplannedRatio ?? null,
        grossRevenue: individual.ordersInPeriod?.grossRevenue ?? null
      };
    })
    .sort((a, b) => (Number(b.coveragePercent) || 0) - (Number(a.coveragePercent) || 0));
  rankingsRows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return { month: yyyyMm, metricsVersion: 'mrepRankingsV1', rankings: rankingsRows };
};

const mrepOnlyOverviewReps = (reps) =>
  reps
    .filter((r) => r.roleCode === DEFAULT_MEDICAL_REP_CODE)
    .map((r) => ({
      ...r,
      ...(r.personalMetrics || {}),
      coverage: r.personalMetrics?.coverage ?? r.coverage,
      planExecution: r.personalMetrics?.planExecution ?? r.planExecution,
      target: r.personalMetrics?.target ?? r.target,
      ordersInPeriod: r.personalMetrics?.ordersInPeriod ?? r.ordersInPeriod,
      totalGrossSalesTp: r.personalMetrics?.totalGrossSalesTp ?? r.totalGrossSalesTp,
      attendanceScorePercent: r.personalMetrics?.attendanceScorePercent ?? r.attendanceScorePercent
    }));

const trends = async (companyId, viewerUser, monthsCount, timeZone, { repId: explicitRepId } = {}) => {
  const zone = businessTime.requireCompanyIanaZone(timeZone);
  const now = DateTime.now().setZone(zone);
  const n = Math.min(24, Math.max(1, Number(monthsCount) || 6));
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    months.push(now.minus({ months: i }).toFormat('yyyy-MM'));
  }
  const points = [];
  for (const m of months) {
    const overview = await monthlyOverview(companyId, viewerUser, m, timeZone, {
      repId: explicitRepId
    });
    points.push({ month: m, reps: mrepOnlyOverviewReps(overview.reps), scopeSummary: overview.scopeSummary });
  }
  return { metricsVersion: 'mrepTrendsV2', months, points };
};

const territoryCompare = async (companyId, parentTerritoryId, yyyyMm, timeZone, viewerUserId, permissions) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const pid = new mongoose.Types.ObjectId(String(parentTerritoryId));
  const parent = await Territory.findOne({ _id: pid, companyId: cid, isDeleted: { $ne: true } })
    .select('name kind')
    .lean();
  if (!parent) throw new ApiError(404, 'Territory not found');

  const scopeCtx = await buildAllowedTerritoryIdSet(companyId, viewerUserId, permissions);
  await assertTerritoryCompareParentAccess(companyId, parentTerritoryId, scopeCtx);

  const children = await Territory.find({
    companyId: cid,
    parentId: pid,
    isDeleted: { $ne: true }
  })
    .select('name code kind')
    .sort({ name: 1 })
    .lean();

  const rows = [];
  for (const ch of children) {
    if (!scopeCtx.bypass && scopeCtx.ids && !scopeCtx.ids.has(String(ch._id))) {
      continue;
    }
    const cov = await coverageService.territoryCoverageMonth(companyId, ch._id, yyyyMm, timeZone);
    rows.push({
      territoryId: String(ch._id),
      name: ch.name,
      code: ch.code,
      kind: ch.kind,
      coveragePercent: cov.coveragePercent,
      doctorsTracked: cov.doctorsTracked
    });
  }

  return {
    month: yyyyMm,
    parentTerritoryId: String(parentTerritoryId),
    parentName: parent.name,
    metricsDefinition: 'coverageActualV1',
    children: rows
  };
};

module.exports = {
  monthlyOverview,
  doctorCoverageForRep,
  territoryCoverage,
  assertCanViewRep,
  deviationSummary,
  rankings,
  trends,
  territoryCompare
};
