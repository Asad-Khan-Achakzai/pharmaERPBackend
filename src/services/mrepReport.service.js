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
const coverageService = require('./coverage.service');
const mrepKpiService = require('./mrepKpi.service');
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

const BATCH = 8;

const monthlyOverview = async (companyId, viewerUser, yyyyMm, timeZone, { repId: explicitRepId } = {}) => {
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

  const rows = [];
  for (let i = 0; i < repOids.length; i += BATCH) {
    const chunk = repOids.slice(i, i + BATCH);
    const part = await Promise.all(
      chunk.map((oid) => mrepKpiService.monthlyRowForRep(companyId, oid, yyyyMm, timeZone))
    );
    rows.push(...part);
  }

  return {
    month: yyyyMm,
    reps: rows.map((r) => ({
      ...r,
      name: byId[r.repId]?.name || null,
      email: byId[r.repId]?.email || null,
      employeeCode: byId[r.repId]?.employeeCode || null
    }))
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
    .map((r) => ({
      repId: r.repId,
      name: r.name,
      employeeCode: r.employeeCode,
      coveragePercent: r.coverage?.coveragePercent ?? null,
      visitCompletionPercent: r.planExecution?.visitCompletionPercent ?? null,
      adherencePercent: r.planExecution?.adherencePercent ?? null,
      unplannedRatio: r.planExecution?.unplannedRatio ?? null,
      grossRevenue: r.ordersInPeriod?.grossRevenue ?? null
    }))
    .sort((a, b) => (Number(b.coveragePercent) || 0) - (Number(a.coveragePercent) || 0));
  rankingsRows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return { month: yyyyMm, metricsVersion: 'mrepRankingsV1', rankings: rankingsRows };
};

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
    points.push({ month: m, reps: overview.reps });
  }
  return { metricsVersion: 'mrepTrendsV1', months, points };
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
