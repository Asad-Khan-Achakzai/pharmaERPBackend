/**
 * Territory Coverage Dashboard — hierarchical Zone/Area/Brick lazy tree + doctor lists.
 * Distinct from monthly coverageActualV1 (target vs VisitLog).
 */
const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const User = require('../models/User');
const Doctor = require('../models/Doctor');
const Territory = require('../models/Territory');
const PlanItem = require('../models/PlanItem');
const VisitLog = require('../models/VisitLog');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const { escapeRegex } = require('../utils/listQuery');
const { PLAN_ITEM_TYPE, PLAN_ITEM_STATUS, TERRITORY_KIND } = require('../constants/enums');
const {
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE,
  TEAM_VIEW_ALL_REPORTS
} = require('../constants/rbac');
const mrepOwnership = require('./mrepOwnership.service');
const { assertCanViewRep } = require('./mrepReport.service');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { userHasTenantWideAccess, userHasPermission } = require('../utils/effectivePermissions');
const {
  buildAllowedTerritoryIdSet,
  assertTerritoryCompareParentAccess
} = require('../utils/territoryCompareScope.util');

const METRICS_VERSION = 'territoryCoverageDashboardV2';
const METRICS_VERSION_FLAT = 'territoryCoverageDashboardV1';
/** Allow up to one year so custom ranges (e.g. 7–8 months) work; still below general report max (800). */
const MAX_DASHBOARD_RANGE_DAYS = 366;

const ROOT_KIND = {
  COMPANY: 'COMPANY',
  ZONE: 'ZONE',
  AREA: 'AREA',
  BRICK: 'BRICK'
};

const DOCTOR_ACTIVITY_STATUS = {
  NOT_PLANNED: 'NOT_PLANNED',
  PLANNED: 'PLANNED',
  VISITED: 'VISITED',
  MISSED: 'MISSED'
};

const pctOrNull = (numerator, denominator) => {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
};

const assertDashboardRange = (fromYmd, toYmd, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  if (!fromYmd || !toYmd || !/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(toYmd)) {
    throw new ApiError(400, 'from and to must be YYYY-MM-DD');
  }
  if (fromYmd > toYmd) throw new ApiError(400, 'from must be on or before to');
  const start = DateTime.fromISO(fromYmd, { zone });
  const end = DateTime.fromISO(toYmd, { zone });
  if (!start.isValid || !end.isValid) throw new ApiError(400, 'Invalid from/to date');
  const days = Math.floor(end.diff(start, 'days').days) + 1;
  if (days > MAX_DASHBOARD_RANGE_DAYS) {
    throw new ApiError(400, `Date range cannot exceed ${MAX_DASHBOARD_RANGE_DAYS} days`);
  }
  return {
    startDoc: businessTime.businessDayStartUtc(fromYmd, zone),
    endDoc: businessTime.businessDayStartUtc(toYmd, zone),
    visitRange: businessTime.coalesceBusinessDateRangeFromYmd(fromYmd, toYmd, zone),
    zone
  };
};

/**
 * Resolve latest-activity status for one doctor within the selected range.
 * @param {{ ymd: string, hasVisit?: boolean, planStatuses?: string[] }[]} dayEvents
 */
const latestActivityStatus = (dayEvents) => {
  if (!dayEvents?.length) return DOCTOR_ACTIVITY_STATUS.NOT_PLANNED;
  const sorted = [...dayEvents].sort((a, b) => String(b.ymd).localeCompare(String(a.ymd)));
  const latest = sorted[0];
  if (latest.hasVisit || (latest.planStatuses || []).includes(PLAN_ITEM_STATUS.VISITED)) {
    return DOCTOR_ACTIVITY_STATUS.VISITED;
  }
  if ((latest.planStatuses || []).includes(PLAN_ITEM_STATUS.MISSED)) {
    return DOCTOR_ACTIVITY_STATUS.MISSED;
  }
  if ((latest.planStatuses || []).includes(PLAN_ITEM_STATUS.PENDING)) {
    return DOCTOR_ACTIVITY_STATUS.PLANNED;
  }
  return DOCTOR_ACTIVITY_STATUS.NOT_PLANNED;
};

const emptyBrickMetrics = () => ({
  totalAssignedDoctors: 0,
  plannedSet: new Set(),
  visitedSet: new Set(),
  planVisitedSet: new Set(),
  remainingSet: new Set(),
  missedSet: new Set(),
  lastActivityAt: null
});

const finalizeMetrics = (m) => {
  const totalAssignedDoctors = m.totalAssignedDoctors;
  const plannedDoctors = m.plannedSet.size;
  const visitedDoctors = m.visitedSet.size;
  const remainingDoctors = m.remainingSet.size;
  const missedDoctors = m.missedSet.size;
  const hasPlan = plannedDoctors > 0;
  let visitedPlanned = 0;
  for (const id of m.plannedSet) {
    if (m.visitedSet.has(id) || m.planVisitedSet.has(id)) visitedPlanned += 1;
  }
  return {
    totalAssignedDoctors,
    plannedDoctors,
    visitedDoctors,
    remainingDoctors,
    missedDoctors,
    hasPlan,
    coveragePercent: pctOrNull(visitedDoctors, totalAssignedDoctors),
    planCompletionPercent: hasPlan ? pctOrNull(visitedPlanned, plannedDoctors) : null,
    lastActivityAt: m.lastActivityAt
  };
};

const bumpLastActivity = (metrics, at) => {
  if (!at) return;
  const t = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(t.getTime())) return;
  if (!metrics.lastActivityAt || t > metrics.lastActivityAt) {
    metrics.lastActivityAt = t;
  }
};

const sortMetricRows = (rows, sort) => {
  const mode = String(sort || 'coverageAsc');
  rows.sort((a, b) => {
    if (mode === 'nameAsc') {
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    const ca = a.coveragePercent;
    const cb = b.coveragePercent;
    if (mode === 'coverageDesc') {
      if (ca == null && cb == null) return String(a.name || '').localeCompare(String(b.name || ''));
      if (ca == null) return 1;
      if (cb == null) return -1;
      if (cb !== ca) return cb - ca;
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    if (ca == null && cb == null) return String(a.name || '').localeCompare(String(b.name || ''));
    if (ca == null) return 1;
    if (cb == null) return -1;
    if (ca !== cb) return ca - cb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return rows;
};

/** Role → dashboard root level. */
const resolveRootKind = (viewerUser) => {
  if (userHasTenantWideAccess(viewerUser)) return ROOT_KIND.COMPANY;
  const code = viewerUser.roleCode != null ? String(viewerUser.roleCode) : '';
  if (code === DEFAULT_RM_CODE) return ROOT_KIND.ZONE;
  if (code === DEFAULT_ASM_CODE) return ROOT_KIND.AREA;
  return ROOT_KIND.BRICK;
};

/**
 * Employee ids whose PlanItems/VisitLogs count.
 * `null` = entire company (admin / tenant-wide).
 * @returns {Promise<null|mongoose.Types.ObjectId[]>}
 */
const resolveActivityEmployeeIds = async (companyId, viewerUser, explicitRepId) => {
  if (explicitRepId) {
    await assertCanViewRep(companyId, viewerUser, explicitRepId);
    return [new mongoose.Types.ObjectId(String(explicitRepId))];
  }
  if (userHasTenantWideAccess(viewerUser)) return null;
  if (userHasPermission(viewerUser, TEAM_VIEW_ALL_REPORTS)) {
    const ids = await resolveSubtreeUserIds(companyId, viewerUser.userId, {
      includeSelf: true,
      activeOnly: true
    });
    if (!ids.length) return [new mongoose.Types.ObjectId(String(viewerUser.userId))];
    return ids.map((id) => new mongoose.Types.ObjectId(String(id)));
  }
  return [new mongoose.Types.ObjectId(String(viewerUser.userId))];
};

const isSingleEmployeeScope = (employeeIds) => Array.isArray(employeeIds) && employeeIds.length === 1;

/**
 * Brick ObjectIds in the viewer's (or subject's) geographic footprint.
 */
const resolveFootprintBrickIds = async (companyId, viewerUser, explicitRepId, activityEmployeeIds) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));

  if (explicitRepId) {
    const rep = await User.findOne({
      _id: explicitRepId,
      companyId: cid,
      isDeleted: { $ne: true },
      isActive: true
    })
      .select('territoryId coverageTerritoryIds')
      .lean();
    if (!rep) throw new ApiError(404, 'Representative not found or inactive');
    return mrepOwnership.unionBrickIdsForRep(cid, rep);
  }

  if (userHasTenantWideAccess(viewerUser)) {
    const bricks = await Territory.find({
      companyId: cid,
      kind: TERRITORY_KIND.BRICK,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    return bricks.map((b) => b._id);
  }

  const userIds =
    activityEmployeeIds && activityEmployeeIds.length
      ? activityEmployeeIds
      : [new mongoose.Types.ObjectId(String(viewerUser.userId))];

  const users = await User.find({
    _id: { $in: userIds },
    companyId: cid,
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('territoryId coverageTerritoryIds')
    .lean();

  const set = new Set();
  for (const u of users) {
    const bricks = await mrepOwnership.unionBrickIdsForRep(cid, u);
    for (const b of bricks) set.add(String(b));
  }
  return [...set].map((s) => new mongoose.Types.ObjectId(s));
};

/**
 * Doctors in scope for a brick set.
 * Single-rep MR-style: owned doctors. Manager/admin: doctors on those bricks.
 */
const loadDoctorsForBricks = async (companyId, brickIds, activityEmployeeIds) => {
  const cid = new mongoose.Types.ObjectId(String(companyId));
  if (!brickIds.length) return [];

  if (isSingleEmployeeScope(activityEmployeeIds)) {
    const filter = await mrepOwnership.ownedDoctorsFilter(companyId, activityEmployeeIds[0]);
    if (!filter) return [];
    return Doctor.find(filter).select('_id name doctorCode territoryId assignedRepId').lean();
  }

  return Doctor.find({
    companyId: cid,
    territoryId: { $in: brickIds },
    isDeleted: { $ne: true },
    isActive: true
  })
    .select('_id name doctorCode territoryId assignedRepId')
    .lean();
};

const employeeMatch = (employeeIds) => {
  if (employeeIds == null) return {};
  if (employeeIds.length === 1) return { employeeId: employeeIds[0] };
  return { employeeId: { $in: employeeIds } };
};

/**
 * Aggregate metrics for doctors already loaded, keyed by brick, plus overall.
 */
const aggregateDoctorActivity = async ({
  cid,
  doctors,
  brickIds,
  employeeIds,
  startDoc,
  endDoc,
  visitRange
}) => {
  const metricsByBrick = new Map();
  const overall = emptyBrickMetrics();
  const doctorBrickById = new Map();

  const ensureBrick = (brickKey) => {
    if (!metricsByBrick.has(brickKey)) metricsByBrick.set(brickKey, emptyBrickMetrics());
    return metricsByBrick.get(brickKey);
  };

  for (const bid of brickIds) {
    ensureBrick(String(bid));
  }

  for (const d of doctors) {
    const did = String(d._id);
    const brickKey = d.territoryId ? String(d.territoryId) : '__none__';
    doctorBrickById.set(did, brickKey);
    if (brickKey === '__none__') continue;
    const bm = ensureBrick(brickKey);
    bm.totalAssignedDoctors += 1;
    overall.totalAssignedDoctors += 1;
  }

  const doctorIds = doctors.map((d) => d._id);
  if (!doctorIds.length) {
    return { metricsByBrick, overall, doctorBrickById };
  }

  const dids = doctorIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const emp = employeeMatch(employeeIds);
  const [planRows, visitRows] = await Promise.all([
    PlanItem.find({
      companyId: cid,
      ...emp,
      doctorId: { $in: dids },
      date: { $gte: startDoc, $lte: endDoc },
      type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
      isDeleted: { $ne: true }
    })
      .select('doctorId status')
      .lean(),
    VisitLog.find({
      companyId: cid,
      ...emp,
      doctorId: { $in: dids },
      visitTime: { $gte: visitRange.$gte, $lte: visitRange.$lte },
      isDeleted: { $ne: true }
    })
      .select('doctorId visitTime')
      .lean()
  ]);

  for (const p of planRows) {
    const did = String(p.doctorId);
    const brickKey = doctorBrickById.get(did) || '__none__';
    if (brickKey === '__none__') continue;
    const bm = ensureBrick(brickKey);
    bm.plannedSet.add(did);
    overall.plannedSet.add(did);
    if (p.status === PLAN_ITEM_STATUS.PENDING) {
      bm.remainingSet.add(did);
      overall.remainingSet.add(did);
    } else if (p.status === PLAN_ITEM_STATUS.MISSED) {
      bm.missedSet.add(did);
      overall.missedSet.add(did);
    } else if (p.status === PLAN_ITEM_STATUS.VISITED) {
      bm.planVisitedSet.add(did);
      overall.planVisitedSet.add(did);
    }
  }

  for (const v of visitRows) {
    const did = String(v.doctorId);
    const brickKey = doctorBrickById.get(did) || '__none__';
    if (brickKey === '__none__') continue;
    const bm = ensureBrick(brickKey);
    bm.visitedSet.add(did);
    overall.visitedSet.add(did);
    bumpLastActivity(bm, v.visitTime);
    bumpLastActivity(overall, v.visitTime);
  }

  return { metricsByBrick, overall, doctorBrickById };
};

const mergeMetricsInto = (target, source) => {
  target.totalAssignedDoctors += source.totalAssignedDoctors || 0;
  for (const id of source.plannedSet || []) target.plannedSet.add(id);
  for (const id of source.visitedSet || []) target.visitedSet.add(id);
  for (const id of source.planVisitedSet || []) target.planVisitedSet.add(id);
  for (const id of source.remainingSet || []) target.remainingSet.add(id);
  for (const id of source.missedSet || []) target.missedSet.add(id);
  bumpLastActivity(target, source.lastActivityAt);
};

const nodeBricksIntersectingFootprint = async (companyId, node, footprintSet) => {
  const all = await mrepOwnership.brickIdsForTerritoryNode(companyId, node);
  return all.filter((id) => footprintSet.has(String(id)));
};

const allowedNode = (scopeCtx, territoryId) => {
  if (scopeCtx.bypass) return true;
  return scopeCtx.ids && scopeCtx.ids.has(String(territoryId));
};

/**
 * Root nodes for the viewer's hierarchy level.
 */
const loadRootTerritoryNodes = async (cid, rootKind, footprintBrickIds, scopeCtx) => {
  if (rootKind === ROOT_KIND.COMPANY) {
    return Territory.find({
      companyId: cid,
      kind: TERRITORY_KIND.ZONE,
      parentId: null,
      isDeleted: { $ne: true }
    })
      .select('_id name code kind depth parentId materializedPath')
      .sort({ name: 1 })
      .lean();
  }

  if (rootKind === ROOT_KIND.BRICK) {
    if (!footprintBrickIds.length) return [];
    return Territory.find({
      _id: { $in: footprintBrickIds },
      companyId: cid,
      kind: TERRITORY_KIND.BRICK,
      isDeleted: { $ne: true }
    })
      .select('_id name code kind depth parentId materializedPath')
      .sort({ name: 1 })
      .lean();
  }

  if (!footprintBrickIds.length) return [];

  const bricks = await Territory.find({
    _id: { $in: footprintBrickIds },
    companyId: cid,
    kind: TERRITORY_KIND.BRICK,
    isDeleted: { $ne: true }
  })
    .select('parentId materializedPath')
    .lean();

  if (rootKind === ROOT_KIND.AREA) {
    const areaIds = [
      ...new Set(bricks.map((b) => (b.parentId ? String(b.parentId) : null)).filter(Boolean))
    ].map((s) => new mongoose.Types.ObjectId(s));
    if (!areaIds.length) return [];
    const areas = await Territory.find({
      _id: { $in: areaIds },
      companyId: cid,
      kind: TERRITORY_KIND.AREA,
      isDeleted: { $ne: true }
    })
      .select('_id name code kind depth parentId materializedPath')
      .sort({ name: 1 })
      .lean();
    return areas.filter((a) => allowedNode(scopeCtx, a._id));
  }

  // ZONE
  const zoneIds = new Set();
  for (const b of bricks) {
    const parts = String(b.materializedPath || '')
      .split('/')
      .filter(Boolean);
    if (parts[0]) zoneIds.add(parts[0]);
  }
  if (!zoneIds.size) return [];
  const zones = await Territory.find({
    _id: { $in: [...zoneIds].map((s) => new mongoose.Types.ObjectId(s)) },
    companyId: cid,
    kind: TERRITORY_KIND.ZONE,
    isDeleted: { $ne: true }
  })
    .select('_id name code kind depth parentId materializedPath')
    .sort({ name: 1 })
    .lean();
  return zones.filter((z) => allowedNode(scopeCtx, z._id));
};

const loadChildTerritoryNodes = async (cid, parentId, footprintSet, scopeCtx) => {
  const children = await Territory.find({
    companyId: cid,
    parentId: new mongoose.Types.ObjectId(String(parentId)),
    isDeleted: { $ne: true }
  })
    .select('_id name code kind depth parentId materializedPath')
    .sort({ name: 1 })
    .lean();

  const out = [];
  for (const ch of children) {
    if (!allowedNode(scopeCtx, ch._id)) continue;
    if (ch.kind === TERRITORY_KIND.BRICK) {
      if (footprintSet.has(String(ch._id))) out.push(ch);
      continue;
    }
    const bricks = await nodeBricksIntersectingFootprint(cid, ch, footprintSet);
    if (bricks.length) out.push(ch);
  }
  return out;
};

const metricsForBrickSubset = (metricsByBrick, brickIds) => {
  const acc = emptyBrickMetrics();
  for (const id of brickIds) {
    const m = metricsByBrick.get(String(id));
    if (m) mergeMetricsInto(acc, m);
  }
  return acc;
};

/** Flat brick dashboard (MR shortcut / backward compatible). */
const coverageDashboard = async (companyId, viewerUser, query, timeZone) => {
  const from = String(query.from);
  const to = String(query.to);
  const { startDoc, endDoc, visitRange } = assertDashboardRange(from, to, timeZone);
  const activityEmployeeIds = await resolveActivityEmployeeIds(
    companyId,
    viewerUser,
    query.repId || null
  );
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const footprintBrickIds = await resolveFootprintBrickIds(
    companyId,
    viewerUser,
    query.repId || null,
    activityEmployeeIds
  );
  const doctors = await loadDoctorsForBricks(companyId, footprintBrickIds, activityEmployeeIds);
  const { metricsByBrick, overall } = await aggregateDoctorActivity({
    cid,
    doctors,
    brickIds: footprintBrickIds,
    employeeIds: activityEmployeeIds,
    startDoc,
    endDoc,
    visitRange
  });

  const brickMetaById = new Map();
  if (footprintBrickIds.length) {
    const terrRows = await Territory.find({
      _id: { $in: footprintBrickIds },
      companyId: cid,
      kind: TERRITORY_KIND.BRICK,
      isDeleted: { $ne: true }
    })
      .select('name code')
      .lean();
    for (const t of terrRows) {
      brickMetaById.set(String(t._id), { brickId: String(t._id), name: t.name, code: t.code || null });
    }
  }

  let bricks = [];
  for (const [brickKey, raw] of metricsByBrick.entries()) {
    if (brickKey === '__none__') continue;
    const fin = finalizeMetrics(raw);
    const meta = brickMetaById.get(brickKey) || {
      brickId: brickKey,
      name: 'Unknown brick',
      code: null
    };
    bricks.push({
      brickId: meta.brickId,
      name: meta.name,
      code: meta.code,
      totalAssignedDoctors: fin.totalAssignedDoctors,
      plannedDoctors: fin.plannedDoctors,
      visitedDoctors: fin.visitedDoctors,
      remainingDoctors: fin.remainingDoctors,
      missedDoctors: fin.missedDoctors,
      coveragePercent: fin.coveragePercent,
      planCompletionPercent: fin.planCompletionPercent,
      hasPlan: fin.hasPlan,
      lastActivityAt: fin.lastActivityAt
    });
  }

  const totalBricksUnfiltered = bricks.length;
  const search = query.search != null ? String(query.search).trim() : '';
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    bricks = bricks.filter((b) => rx.test(b.name || '') || rx.test(b.code || ''));
  }
  sortMetricRows(bricks, query.sort);

  const overallFin = finalizeMetrics(overall);
  return {
    metricsVersion: METRICS_VERSION_FLAT,
    from,
    to,
    hasPlan: overallFin.hasPlan,
    overall: {
      totalBricks: totalBricksUnfiltered,
      totalAssignedDoctors: overallFin.totalAssignedDoctors,
      plannedDoctors: overallFin.plannedDoctors,
      visitedDoctors: overallFin.visitedDoctors,
      remainingDoctors: overallFin.remainingDoctors,
      missedDoctors: overallFin.missedDoctors,
      coveragePercent: overallFin.coveragePercent,
      planCompletionPercent: overallFin.planCompletionPercent,
      lastActivityAt: overallFin.lastActivityAt
    },
    bricks,
    extensions: {}
  };
};

/** Hierarchical lazy nodes: summary + children for one level. */
const coverageNodes = async (companyId, viewerUser, query, timeZone) => {
  const from = String(query.from);
  const to = String(query.to);
  const { startDoc, endDoc, visitRange } = assertDashboardRange(from, to, timeZone);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const rootKind = resolveRootKind(viewerUser);
  const activityEmployeeIds = await resolveActivityEmployeeIds(
    companyId,
    viewerUser,
    query.repId || null
  );
  const scopeCtx = await buildAllowedTerritoryIdSet(
    companyId,
    viewerUser.userId,
    viewerUser.permissions
  );
  const footprintBrickIds = await resolveFootprintBrickIds(
    companyId,
    viewerUser,
    query.repId || null,
    activityEmployeeIds
  );
  const footprintSet = new Set(footprintBrickIds.map((id) => String(id)));

  let parent = null;
  let childNodes = [];

  const parentTerritoryId =
    query.parentTerritoryId != null && String(query.parentTerritoryId).trim() !== ''
      ? String(query.parentTerritoryId).trim()
      : null;

  if (parentTerritoryId) {
    if (!mongoose.Types.ObjectId.isValid(parentTerritoryId)) {
      throw new ApiError(400, 'Invalid parentTerritoryId');
    }
    await assertTerritoryCompareParentAccess(companyId, parentTerritoryId, scopeCtx);
    const parentDoc = await Territory.findOne({
      _id: parentTerritoryId,
      companyId: cid,
      isDeleted: { $ne: true }
    })
      .select('_id name code kind depth')
      .lean();
    if (!parentDoc) throw new ApiError(404, 'Territory not found');
    parent = {
      territoryId: String(parentDoc._id),
      name: parentDoc.name,
      code: parentDoc.code || null,
      kind: parentDoc.kind
    };
    childNodes = await loadChildTerritoryNodes(cid, parentTerritoryId, footprintSet, scopeCtx);
  } else {
    childNodes = await loadRootTerritoryNodes(cid, rootKind, footprintBrickIds, scopeCtx);
  }

  const doctors = await loadDoctorsForBricks(companyId, footprintBrickIds, activityEmployeeIds);
  const { metricsByBrick } = await aggregateDoctorActivity({
    cid,
    doctors,
    brickIds: footprintBrickIds,
    employeeIds: activityEmployeeIds,
    startDoc,
    endDoc,
    visitRange
  });

  const summaryAcc = emptyBrickMetrics();
  let children = [];

  for (const node of childNodes) {
    const nodeBricks =
      node.kind === TERRITORY_KIND.BRICK
        ? footprintSet.has(String(node._id))
          ? [node._id]
          : []
        : await nodeBricksIntersectingFootprint(cid, node, footprintSet);

    const raw = metricsForBrickSubset(metricsByBrick, nodeBricks);
    mergeMetricsInto(summaryAcc, raw);
    const fin = finalizeMetrics(raw);
    children.push({
      territoryId: String(node._id),
      name: node.name,
      code: node.code || null,
      kind: node.kind,
      depth: node.depth != null ? node.depth : null,
      hasChildren: node.kind !== TERRITORY_KIND.BRICK,
      totalAssignedDoctors: fin.totalAssignedDoctors,
      plannedDoctors: fin.plannedDoctors,
      visitedDoctors: fin.visitedDoctors,
      remainingDoctors: fin.remainingDoctors,
      missedDoctors: fin.missedDoctors,
      coveragePercent: fin.coveragePercent,
      planCompletionPercent: fin.planCompletionPercent,
      hasPlan: fin.hasPlan,
      lastActivityAt: fin.lastActivityAt
    });
  }

  const search = query.search != null ? String(query.search).trim() : '';
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    children = children.filter((c) => rx.test(c.name || '') || rx.test(c.code || ''));
  }
  sortMetricRows(children, query.sort);

  const summaryFin = finalizeMetrics(summaryAcc);
  let totalBricks = footprintBrickIds.length;
  if (parentTerritoryId) {
    const parentBricks = await nodeBricksIntersectingFootprint(
      cid,
      { _id: parentTerritoryId },
      footprintSet
    );
    totalBricks = parentBricks.length;
  }

  return {
    metricsVersion: METRICS_VERSION,
    from,
    to,
    rootKind,
    parent,
    hasPlan: summaryFin.hasPlan,
    summary: {
      totalChildren: children.length,
      totalBricks,
      totalAssignedDoctors: summaryFin.totalAssignedDoctors,
      plannedDoctors: summaryFin.plannedDoctors,
      visitedDoctors: summaryFin.visitedDoctors,
      remainingDoctors: summaryFin.remainingDoctors,
      missedDoctors: summaryFin.missedDoctors,
      coveragePercent: summaryFin.coveragePercent,
      planCompletionPercent: summaryFin.planCompletionPercent,
      lastActivityAt: summaryFin.lastActivityAt
    },
    children,
    extensions: {}
  };
};

const brickDoctors = async (companyId, viewerUser, brickId, query, timeZone) => {
  const from = String(query.from);
  const to = String(query.to);
  const { startDoc, endDoc, visitRange, zone } = assertDashboardRange(from, to, timeZone);
  const activityEmployeeIds = await resolveActivityEmployeeIds(
    companyId,
    viewerUser,
    query.repId || null
  );
  const cid = new mongoose.Types.ObjectId(String(companyId));

  if (!mongoose.Types.ObjectId.isValid(String(brickId))) {
    throw new ApiError(400, 'Invalid brickId');
  }

  const scopeCtx = await buildAllowedTerritoryIdSet(
    companyId,
    viewerUser.userId,
    viewerUser.permissions
  );
  if (!allowedNode(scopeCtx, brickId)) {
    const footprint = await resolveFootprintBrickIds(
      companyId,
      viewerUser,
      query.repId || null,
      activityEmployeeIds
    );
    if (!footprint.some((id) => String(id) === String(brickId))) {
      throw new ApiError(403, 'You cannot view doctors for this brick');
    }
  }

  const brickOid = new mongoose.Types.ObjectId(String(brickId));
  const doctors = await loadDoctorsForBricks(companyId, [brickOid], activityEmployeeIds);
  const brickDoctorsList = doctors.filter(
    (d) => d.territoryId && String(d.territoryId) === String(brickId)
  );
  const doctorIds = brickDoctorsList.map((d) => d._id);

  const activity = new Map();
  for (const d of brickDoctorsList) {
    activity.set(String(d._id), {
      days: new Map(),
      lastVisitAt: null,
      lastVisitLogId: null,
      navPlanItemId: null,
      navPlanYmd: null
    });
  }

  const ensureDay = (rec, ymd) => {
    if (!rec.days.has(ymd)) {
      rec.days.set(ymd, { hasVisit: false, planStatuses: new Set(), planItemId: null });
    }
    return rec.days.get(ymd);
  };

  if (doctorIds.length) {
    const dids = doctorIds.map((id) => new mongoose.Types.ObjectId(String(id)));
    const emp = employeeMatch(activityEmployeeIds);
    const [planRows, visitRows] = await Promise.all([
      PlanItem.find({
        companyId: cid,
        ...emp,
        doctorId: { $in: dids },
        date: { $gte: startDoc, $lte: endDoc },
        type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
        isDeleted: { $ne: true }
      })
        .select('_id doctorId status date')
        .lean(),
      VisitLog.find({
        companyId: cid,
        ...emp,
        doctorId: { $in: dids },
        visitTime: { $gte: visitRange.$gte, $lte: visitRange.$lte },
        isDeleted: { $ne: true }
      })
        .select('_id doctorId visitTime')
        .lean()
    ]);

    for (const p of planRows) {
      const did = String(p.doctorId);
      const rec = activity.get(did);
      if (!rec) continue;
      const ymd = businessTime.businessDayKeyFromUtcInstant(p.date, zone);
      const day = ensureDay(rec, ymd);
      day.planStatuses.add(p.status);
      if (!day.planItemId) day.planItemId = String(p._id);
      if (
        !rec.navPlanYmd ||
        ymd > rec.navPlanYmd ||
        (ymd === rec.navPlanYmd && p.status === PLAN_ITEM_STATUS.VISITED)
      ) {
        rec.navPlanYmd = ymd;
        rec.navPlanItemId = String(p._id);
      }
    }

    for (const v of visitRows) {
      const did = String(v.doctorId);
      const rec = activity.get(did);
      if (!rec) continue;
      const ymd = businessTime.businessDayKeyFromUtcInstant(v.visitTime, zone);
      const day = ensureDay(rec, ymd);
      day.hasVisit = true;
      const vt = v.visitTime instanceof Date ? v.visitTime : new Date(v.visitTime);
      if (!rec.lastVisitAt || vt > rec.lastVisitAt) {
        rec.lastVisitAt = vt;
        rec.lastVisitLogId = String(v._id);
      }
    }
  }

  let rows = [];
  for (const d of brickDoctorsList) {
    const did = String(d._id);
    const rec = activity.get(did);
    const dayEvents = [...(rec?.days?.entries() || [])].map(([ymd, day]) => ({
      ymd,
      hasVisit: day.hasVisit,
      planStatuses: [...day.planStatuses]
    }));
    const status = latestActivityStatus(dayEvents);
    const lastVisitAt = rec?.lastVisitAt || null;
    const lastVisitYmd = lastVisitAt
      ? businessTime.businessDayKeyFromUtcInstant(lastVisitAt, zone)
      : null;
    rows.push({
      doctorId: did,
      name: d.name,
      doctorCode: d.doctorCode || null,
      status,
      lastVisitAt,
      lastVisitYmd,
      lastVisitTime: null,
      planItemId: rec?.navPlanItemId || null,
      planItemDateYmd: rec?.navPlanYmd || null,
      visitLogId: rec?.lastVisitLogId || null
    });
  }

  const search = query.search != null ? String(query.search).trim() : '';
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    rows = rows.filter((r) => rx.test(r.name || '') || rx.test(r.doctorCode || ''));
  }

  const statusFilter = query.status != null ? String(query.status).trim().toUpperCase() : '';
  if (statusFilter && Object.values(DOCTOR_ACTIVITY_STATUS).includes(statusFilter)) {
    rows = rows.filter((r) => r.status === statusFilter);
  }

  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const total = rows.length;
  const start = (page - 1) * limit;
  const items = rows.slice(start, start + limit);

  return {
    brickId: String(brickId),
    from,
    to,
    items,
    pagination: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit) || 1)
    }
  };
};

module.exports = {
  METRICS_VERSION,
  METRICS_VERSION_FLAT,
  MAX_DASHBOARD_RANGE_DAYS,
  ROOT_KIND,
  DOCTOR_ACTIVITY_STATUS,
  pctOrNull,
  latestActivityStatus,
  assertDashboardRange,
  resolveRootKind,
  coverageDashboard,
  coverageNodes,
  brickDoctors
};
