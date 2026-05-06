/**
 * HTTP-facing MRep report orchestration (scope checks + batched rows).
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const coverageService = require('./coverage.service');
const mrepKpiService = require('./mrepKpi.service');

const assertCanViewRep = async (companyId, viewerUserId, repId, permissions) => {
  if (String(viewerUserId) === String(repId)) return;
  if (Array.isArray(permissions) && permissions.includes('admin.access')) return;
  const subtree = await resolveSubtreeUserIds(companyId, viewerUserId, { includeSelf: true });
  const ok = subtree.some((id) => String(id) === String(repId));
  if (!ok) throw new ApiError(403, 'You cannot view this representative’s performance data');
};

const resolveOverviewRepIds = async (companyId, viewerUserId, permissions, explicitRepId) => {
  if (explicitRepId) {
    await assertCanViewRep(companyId, viewerUserId, explicitRepId, permissions);
    return [new mongoose.Types.ObjectId(String(explicitRepId))];
  }
  if (Array.isArray(permissions) && (permissions.includes('admin.access') || permissions.includes('team.viewAllReports'))) {
    const subtree = await resolveSubtreeUserIds(companyId, viewerUserId, { includeSelf: true });
    return subtree.length ? subtree : [new mongoose.Types.ObjectId(String(viewerUserId))];
  }
  return [new mongoose.Types.ObjectId(String(viewerUserId))];
};

const BATCH = 8;

const monthlyOverview = async (companyId, viewerUserId, permissions, yyyyMm, timeZone, { repId: explicitRepId } = {}) => {
  const repOids = await resolveOverviewRepIds(companyId, viewerUserId, permissions, explicitRepId);
  const users = await User.find({
    _id: { $in: repOids },
    companyId,
    isDeleted: { $ne: true }
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

const doctorCoverageForRep = async (companyId, viewerUserId, permissions, repId, yyyyMm, timeZone) => {
  await assertCanViewRep(companyId, viewerUserId, repId, permissions);
  return coverageService.coverageForRepMonth(companyId, repId, yyyyMm, timeZone);
};

const territoryCoverage = async (companyId, territoryId, yyyyMm, timeZone) => {
  return coverageService.territoryCoverageMonth(companyId, territoryId, yyyyMm, timeZone);
};

module.exports = {
  monthlyOverview,
  doctorCoverageForRep,
  territoryCoverage,
  assertCanViewRep
};
