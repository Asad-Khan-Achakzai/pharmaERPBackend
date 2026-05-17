const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const Territory = require('../models/Territory');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ROLES, TERRITORY_KIND } = require('../constants/enums');
const { ADMIN_ACCESS } = require('../constants/rbac');
const auditService = require('./audit.service');
const mrepOwnership = require('./mrepOwnership.service');
const { resolveSubtreeUserIds, assertNoCycle } = require('../utils/teamScope');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { validateReportingHierarchy } = require('../utils/userReportingHierarchy.util');
const { validateTerritoryAnchorForRole } = require('../utils/userTerritoryAnchor.util');

const normalizeEmail = (e) => (e == null || e === '' ? '' : String(e).toLowerCase().trim());

const toObjectIdOrNull = (v) => {
  if (v == null || v === '') return null;
  if (!mongoose.Types.ObjectId.isValid(v)) {
    throw new ApiError(400, 'Invalid id format');
  }
  return new mongoose.Types.ObjectId(v);
};

/**
 * Validate that an optional territoryId belongs to the same company. Returns the resolved
 * ObjectId or null. Throws 400/404 when invalid.
 */
const resolveTerritoryRef = async (companyId, territoryId) => {
  const oid = toObjectIdOrNull(territoryId);
  if (!oid) return null;
  const t = await Territory.findOne({ _id: oid, companyId, isDeleted: { $ne: true } })
    .select('_id isActive')
    .lean();
  if (!t) throw new ApiError(404, 'Territory not found in this company');
  if (t.isActive === false) {
    throw new ApiError(400, 'Cannot assign an inactive territory');
  }
  return oid;
};

/**
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} territoryId
 */
const assertTerritoryAnchorMatchesRole = async (companyId, roleId, territoryId) => {
  if (!territoryId || !roleId) return;
  const tid =
    territoryId && typeof territoryId === 'object' && territoryId._id != null
      ? territoryId._id
      : territoryId;
  if (!mongoose.Types.ObjectId.isValid(tid)) return;
  const t = await Territory.findOne({
    _id: tid,
    companyId,
    isDeleted: { $ne: true }
  })
    .select('kind')
    .lean();
  if (!t || !t.kind) return;
  await validateTerritoryAnchorForRole(Role, roleId, t.kind);
};

const normalizeCoverageTerritoryIds = async (companyId, rawList, primaryTerritoryId) => {
  if (!Array.isArray(rawList)) return [];
  const ids = [
    ...new Set(
      rawList
        .map((x) => (x == null || x === '' ? null : String(x).trim()))
        .filter((s) => s && mongoose.Types.ObjectId.isValid(s))
    )
  ];
  const primary = primaryTerritoryId ? String(primaryTerritoryId) : '';
  const filtered = ids.filter((s) => s !== primary);
  if (!filtered.length) return [];
  const oids = filtered.map((s) => new mongoose.Types.ObjectId(s));
  const found = await Territory.find({ _id: { $in: oids }, companyId, isDeleted: { $ne: true } })
    .select('_id kind')
    .lean();
  if (found.length !== oids.length) throw new ApiError(400, 'One or more coverage territories are invalid');
  return found.map((f) => f._id);
};

/**
 * When anchor is a brick, extra coverage is normally explicit bricks only (new UX).
 * Legacy rows may still store area/zone nodes in `coverageTerritoryIds`; those keep expanding via path.
 */
const inferTerritoryAssignmentLabel = (anchorPopulated, coveragePopulated) => {
  const cov = Array.isArray(coveragePopulated) ? coveragePopulated.filter(Boolean) : [];
  const coverageLen = cov.length;
  const coverageAllBrick =
    coverageLen > 0 && cov.every((c) => typeof c === 'object' && c && c.kind === TERRITORY_KIND.BRICK);
  const anchor = anchorPopulated && typeof anchorPopulated === 'object' ? anchorPopulated : null;
  if (!anchor || !anchor.kind) return { key: 'NONE', label: 'None' };
  const k = anchor.kind;
  if (k === TERRITORY_KIND.ZONE && coverageLen === 0) return { key: 'ENTIRE_ZONE', label: 'Entire Zone' };
  if (k === TERRITORY_KIND.AREA && coverageLen === 0) return { key: 'ENTIRE_AREA', label: 'Entire Area' };
  if (k === TERRITORY_KIND.BRICK && coverageLen === 0) return { key: 'SINGLE_BRICK', label: 'Single Brick' };
  if (k === TERRITORY_KIND.BRICK && coverageLen > 0 && coverageAllBrick) {
    return { key: 'CUSTOM_MULTI_BRICK', label: 'Custom Multi-Brick' };
  }
  if (coverageLen > 0) {
    return { key: 'HIERARCHICAL_PLUS_EXTRA', label: 'Hierarchical + extra coverage' };
  }
  return { key: 'CUSTOM', label: 'Custom / legacy' };
};

/**
 * Validate that an optional managerId belongs to the same company and is active. Cycles are
 * checked separately by `assertNoCycle` for update flows (creates have no descendants yet).
 */
const resolveManagerRef = async (companyId, managerId, { selfId = null } = {}) => {
  const oid = toObjectIdOrNull(managerId);
  if (!oid) return null;
  if (selfId && String(oid) === String(selfId)) {
    throw new ApiError(400, 'A user cannot report to themselves');
  }
  const m = await User.findOne({ _id: oid, companyId, isDeleted: { $ne: true } })
    .select('_id isActive')
    .lean();
  if (!m) throw new ApiError(404, 'Manager user not found in this company');
  if (m.isActive === false) {
    throw new ApiError(400, 'Manager user is inactive');
  }
  return oid;
};

const applyRoleIdToUserPayload = async (companyId, data) => {
  const next = { ...data };
  const rid = data.roleId;
  if (rid !== undefined && rid !== null && rid !== '' && mongoose.Types.ObjectId.isValid(rid)) {
    const role = await Role.findOne({ _id: rid, companyId, isDeleted: { $ne: true } });
    if (!role) throw new ApiError(400, 'Invalid role for this company');
    next.role = (role.permissions || []).includes(ADMIN_ACCESS) ? ROLES.ADMIN : ROLES.MEDICAL_REP;
    next.roleId = role._id;
    next.permissions = [];
    return next;
  }
  if (data.roleId === null || data.roleId === '') {
    next.roleId = null;
  } else if (data.roleId !== undefined && !mongoose.Types.ObjectId.isValid(data.roleId)) {
    throw new ApiError(400, 'Invalid roleId');
  }
  if (data.role === ROLES.ADMIN) {
    next.permissions = ALL_PERMISSIONS;
  }
  return next;
};

const list = async (companyId, query, timeZone = "UTC") => {
  const { page, limit, skip, sort, search } = parsePagination(query);
  const searchTerm = qScalar(search);

  const filter = { companyId };
  if (query.role) filter.role = query.role;
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (searchTerm) {
    const rx = escapeRegex(searchTerm);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } }
    ];
  }
  applyCreatedAtRangeFromQuery(filter, query, timeZone);
  applyCreatedByFromQuery(filter, query);

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('roleId', 'name code isSystem')
      .populate({
        path: 'managerId',
        select: 'name email',
        populate: { path: 'roleId', select: 'code name' }
      })
      .populate('territoryId', 'name code kind')
      .populate('coverageTerritoryIds', 'name code kind'),
    User.countDocuments(filter)
  ]);

  return { docs, total, page, limit };
};

const create = async (companyId, data, reqUser) => {
  if (data.role === ROLES.SUPER_ADMIN) {
    throw new ApiError(400, 'SUPER_ADMIN accounts cannot be created from tenant user management');
  }

  const email = normalizeEmail(data.email);
  if (!email) {
    throw new ApiError(400, 'Valid email is required');
  }
  const existing = await User.findOne({ email });
  if (existing) {
    throw new ApiError(409, 'User with this email already exists');
  }

  const payload = await applyRoleIdToUserPayload(companyId, { ...data, email });
  delete payload.coverageTerritoryIds;

  if (Object.prototype.hasOwnProperty.call(data, 'managerId')) {
    payload.managerId = await resolveManagerRef(companyId, data.managerId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'territoryId')) {
    payload.territoryId = await resolveTerritoryRef(companyId, data.territoryId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'employeeCode')) {
    payload.employeeCode = data.employeeCode ? String(data.employeeCode).trim() : null;
  }

  await validateReportingHierarchy(companyId, payload.roleId, payload.managerId ?? null);
  await assertTerritoryAnchorMatchesRole(companyId, payload.roleId, payload.territoryId);

  let extraCoverage;
  if (Object.prototype.hasOwnProperty.call(data, 'coverageTerritoryIds')) {
    extraCoverage = await normalizeCoverageTerritoryIds(companyId, data.coverageTerritoryIds, payload.territoryId);
  }

  const user = await User.create({
    ...payload,
    companyId,
    createdBy: reqUser.userId,
    ...(extraCoverage !== undefined ? { coverageTerritoryIds: extraCoverage } : {})
  });

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'user.create',
    entityType: 'User',
    entityId: user._id,
    changes: { after: user.toJSON() }
  });

  return user;
};

const getById = async (companyId, id) => {
  const user = await User.findOne({ _id: id, companyId })
    .populate('roleId', 'name code isSystem permissions')
    .populate({
      path: 'managerId',
      select: 'name email',
      populate: { path: 'roleId', select: 'code name' }
    })
    .populate('territoryId', 'name code kind')
    .populate('coverageTerritoryIds', 'name code kind');
  if (!user) throw new ApiError(404, 'User not found');
  const plain = user.toJSON();
  const repLean = {
    territoryId: user.territoryId,
    coverageTerritoryIds: user.coverageTerritoryIds || []
  };
  const eff = await mrepOwnership.effectiveBrickCoverageSummary(companyId, repLean);
  const typeInfo = inferTerritoryAssignmentLabel(user.territoryId, user.coverageTerritoryIds);
  plain.territoryCoverageSummary = {
    assignmentType: typeInfo.label,
    assignmentTypeKey: typeInfo.key,
    brickCount: eff.brickCount,
    previewBricks: eff.previewBricks
  };
  return plain;
};

const update = async (companyId, id, data, reqUser) => {
  const user = await User.findOne({ _id: id, companyId });
  if (!user) throw new ApiError(404, 'User not found');

  if (user.role === ROLES.SUPER_ADMIN || data.role === ROLES.SUPER_ADMIN) {
    throw new ApiError(400, 'SUPER_ADMIN role cannot be changed from tenant user management');
  }

  if (data.email !== undefined && data.email != null) {
    const nextEmail = normalizeEmail(data.email);
    if (nextEmail && nextEmail !== String(user.email).toLowerCase().trim()) {
      const taken = await User.findOne({ email: nextEmail, _id: { $ne: user._id } });
      if (taken) {
        throw new ApiError(409, 'User with this email already exists');
      }
    }
  }

  const before = user.toJSON();

  const toApply = { ...data };
  if (data.email !== undefined && data.email != null) {
    toApply.email = normalizeEmail(data.email);
  }
  const payload = await applyRoleIdToUserPayload(companyId, toApply);
  delete payload.coverageTerritoryIds;
  if (payload.password === '' || payload.password == null) {
    delete payload.password;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'managerId')) {
    const nextMgr = await resolveManagerRef(companyId, data.managerId, { selfId: user._id });
    if (nextMgr) await assertNoCycle(companyId, user._id, nextMgr);
    payload.managerId = nextMgr;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'territoryId')) {
    payload.territoryId = await resolveTerritoryRef(companyId, data.territoryId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'employeeCode')) {
    payload.employeeCode = data.employeeCode ? String(data.employeeCode).trim() : null;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'attendanceApproveDelegateUserId')) {
    const raw = data.attendanceApproveDelegateUserId;
    if (raw == null || raw === '') {
      payload.attendanceApproveDelegateUserId = null;
      payload.attendanceApproveDelegateUntil = null;
    } else {
      const delId = mongoose.Types.ObjectId.isValid(String(raw)) ? String(raw) : null;
      if (!delId) throw new ApiError(400, 'Invalid attendance delegate user id');
      const delUser = await User.findOne({
        _id: delId,
        companyId,
        isActive: true,
        isDeleted: { $ne: true }
      }).select('_id').lean();
      if (!delUser) throw new ApiError(400, 'Delegate user not found or inactive');
      if (String(delUser._id) === String(user._id)) {
        throw new ApiError(400, 'Cannot delegate attendance approvals to yourself');
      }
      payload.attendanceApproveDelegateUserId = delUser._id;
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'attendanceApproveDelegateUntil')) {
    const u = data.attendanceApproveDelegateUntil;
    if (u == null || u === '') {
      payload.attendanceApproveDelegateUntil = null;
    } else {
      const dt = u instanceof Date ? u : new Date(u);
      if (Number.isNaN(dt.getTime())) throw new ApiError(400, 'Invalid attendanceApproveDelegateUntil');
      payload.attendanceApproveDelegateUntil = dt;
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'managerId') || Object.prototype.hasOwnProperty.call(data, 'roleId')) {
    const effectiveRoleId = payload.roleId != null ? payload.roleId : user.roleId;
    const effectiveManagerId = Object.prototype.hasOwnProperty.call(data, 'managerId')
      ? payload.managerId
      : user.managerId;
    await validateReportingHierarchy(companyId, effectiveRoleId, effectiveManagerId);
  }

  if (
    Object.prototype.hasOwnProperty.call(data, 'territoryId') ||
    Object.prototype.hasOwnProperty.call(data, 'roleId')
  ) {
    const effectiveRoleIdForTerritory = Object.prototype.hasOwnProperty.call(payload, 'roleId')
      ? payload.roleId
      : user.roleId;
    const effectiveTerritoryIdForKind = Object.prototype.hasOwnProperty.call(data, 'territoryId')
      ? payload.territoryId
      : user.territoryId;
    await assertTerritoryAnchorMatchesRole(companyId, effectiveRoleIdForTerritory, effectiveTerritoryIdForKind);
  }

  if (Object.prototype.hasOwnProperty.call(data, 'coverageTerritoryIds')) {
    const primary = Object.prototype.hasOwnProperty.call(payload, 'territoryId')
      ? payload.territoryId
      : user.territoryId;
    payload.coverageTerritoryIds = await normalizeCoverageTerritoryIds(
      companyId,
      data.coverageTerritoryIds,
      primary
    );
  }

  Object.assign(user, { ...payload, updatedBy: reqUser.userId });
  await user.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'user.update',
    entityType: 'User',
    entityId: user._id,
    changes: { before, after: user.toJSON() }
  });

  return user;
};

/**
 * Deactivate/activate a user in place (isActive). Does not remove the document — preserves
 * references in orders, attendance, etc.
 */
const setStatus = async (companyId, id, { isActive }, reqUser) => {
  if (typeof isActive !== 'boolean') {
    throw new ApiError(400, 'isActive must be a boolean');
  }

  const user = await User.findOne({ _id: id, companyId });
  if (!user) throw new ApiError(404, 'User not found');

  if (user._id.toString() === reqUser.userId.toString()) {
    throw new ApiError(400, 'You cannot change your own active status');
  }

  if (user.role === ROLES.SUPER_ADMIN) {
    throw new ApiError(400, 'Cannot change active status of a platform account from tenant user management');
  }

  if (isActive === false && user.isActive) {
    const otherActive = await User.countDocuments({
      companyId,
      isActive: true,
      _id: { $ne: user._id }
    });
    if (otherActive === 0) {
      throw new ApiError(400, 'Cannot deactivate the last active user in this company');
    }
  }

  const before = user.toJSON();
  user.isActive = isActive;
  user.updatedBy = reqUser.userId;
  await user.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: isActive ? 'user.activate' : 'user.deactivate',
    entityType: 'User',
    entityId: user._id,
    changes: { before, after: user.toJSON() }
  });

  return user;
};

/**
 * GET /users/team — reporting subtree by default (active users only).
 * - Tenant-wide operators only (SUPER_ADMIN in company, legacy ADMIN, DEFAULT_ADMIN role, `admin.access`):
 *   without `?managerId=`, returns active users in the company. With `?managerId=`, returns that manager's active subtree.
 *   Pass `includeInactive=true` to include deactivated accounts in the roster (admin / HR).
 * - Everyone else (including `team.viewAllReports` roles such as Regional Manager): active subtree of the target manager
 *   (defaults to caller), same as before.
 */
const listTeam = async (companyId, reqUser, query = {}) => {
  const hasManagerFilter = query.managerId && mongoose.Types.ObjectId.isValid(query.managerId);

  const wholeCompany = !hasManagerFilter && userHasTenantWideAccess(reqUser);

  const baseFilter = { companyId };
  const includeInactive = query.includeInactive === 'true' || query.includeInactive === true;
  if (query.isActive === 'true' || query.isActive === 'false') {
    baseFilter.isActive = query.isActive === 'true';
  } else if (!includeInactive) {
    baseFilter.isActive = true;
  }
  const term = qScalar(query.search);
  if (term) {
    const rx = escapeRegex(term);
    baseFilter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } },
      { employeeCode: { $regex: rx, $options: 'i' } }
    ];
  }

  if (wholeCompany) {
    const docs = await User.find(baseFilter)
      .sort({ name: 1 })
      .populate('roleId', 'name code')
      .populate('managerId', 'name email')
      .populate('territoryId', 'name code kind')
      .populate('coverageTerritoryIds', 'name code kind')
      .lean();
    return { docs, total: docs.length };
  }

  const targetId = hasManagerFilter
    ? new mongoose.Types.ObjectId(query.managerId)
    : reqUser.userId;
  const subtreeIds = await resolveSubtreeUserIds(companyId, targetId, {
    includeSelf: query.includeSelf === 'true' || query.includeSelf === true,
    activeOnly: true
  });
  if (!subtreeIds.length) return { docs: [], total: 0 };

  const filter = { ...baseFilter, _id: { $in: subtreeIds } };
  const docs = await User.find(filter)
    .sort({ name: 1 })
    .populate('roleId', 'name code')
    .populate('managerId', 'name email')
    .populate('territoryId', 'name code kind')
    .populate('coverageTerritoryIds', 'name code kind')
    .lean();
  return { docs, total: docs.length };
};

/** GET /users/:id/reports — direct reports of the given user. */
const listDirectReports = async (companyId, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, 'Invalid id format');
  }
  const docs = await User.find({ companyId, managerId: id, isActive: true })
    .sort({ name: 1 })
    .populate('roleId', 'name code')
    .populate('territoryId', 'name code kind')
    .populate('coverageTerritoryIds', 'name code kind')
    .lean();
  return { docs, total: docs.length };
};

/** PATCH /users/:id/manager — set or clear managerId; cycle-checked. */
const setManager = async (companyId, id, { managerId }, reqUser) => {
  const user = await User.findOne({ _id: id, companyId });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.role === ROLES.SUPER_ADMIN) {
    throw new ApiError(400, 'Platform users have no in-tenant manager');
  }
  const before = { managerId: user.managerId };
  const next = await resolveManagerRef(companyId, managerId, { selfId: user._id });
  if (next) await assertNoCycle(companyId, user._id, next);
  await validateReportingHierarchy(companyId, user.roleId, next);
  user.managerId = next;
  user.updatedBy = reqUser.userId;
  await user.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'user.setManager',
    entityType: 'User',
    entityId: user._id,
    changes: { before, after: { managerId: user.managerId } }
  });
  return user;
};

/** PATCH /users/:id/territory — set or clear territoryId. */
const setTerritory = async (companyId, id, { territoryId }, reqUser) => {
  const user = await User.findOne({ _id: id, companyId });
  if (!user) throw new ApiError(404, 'User not found');
  const before = { territoryId: user.territoryId };
  const nextTerritoryId = await resolveTerritoryRef(companyId, territoryId);
  await assertTerritoryAnchorMatchesRole(companyId, user.roleId, nextTerritoryId);
  user.territoryId = nextTerritoryId;
  user.updatedBy = reqUser.userId;
  await user.save();

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'user.setTerritory',
    entityType: 'User',
    entityId: user._id,
    changes: { before, after: { territoryId: user.territoryId } }
  });
  return user;
};

module.exports = {
  list,
  create,
  getById,
  update,
  setStatus,
  listTeam,
  listDirectReports,
  setManager,
  setTerritory
};
