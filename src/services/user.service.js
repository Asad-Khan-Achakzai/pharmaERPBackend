const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const Territory = require('../models/Territory');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/enums');
const { ADMIN_ACCESS } = require('../constants/rbac');
const auditService = require('./audit.service');
const { resolveSubtreeUserIds, assertNoCycle } = require('../utils/teamScope');

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
    .select('_id')
    .lean();
  if (!t) throw new ApiError(404, 'Territory not found in this company');
  return oid;
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
      .populate('managerId', 'name email')
      .populate('territoryId', 'name code kind'),
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

  if (Object.prototype.hasOwnProperty.call(data, 'managerId')) {
    payload.managerId = await resolveManagerRef(companyId, data.managerId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'territoryId')) {
    payload.territoryId = await resolveTerritoryRef(companyId, data.territoryId);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'employeeCode')) {
    payload.employeeCode = data.employeeCode ? String(data.employeeCode).trim() : null;
  }

  const user = await User.create({ ...payload, companyId, createdBy: reqUser.userId });

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
    .populate('managerId', 'name email')
    .populate('territoryId', 'name code kind');
  if (!user) throw new ApiError(404, 'User not found');
  return user;
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
 * GET /users/team — returns active users in caller's reporting subtree (descendants only).
 * If `permissions` includes `team.viewAllReports` AND the caller is a top-of-tree manager
 * (no manager set), they implicitly see their whole org. Admins (`admin.access`) bypass this
 * and can request `?managerId=` for any user.
 */
const listTeam = async (companyId, reqUser, query = {}) => {
  const targetId =
    query.managerId && mongoose.Types.ObjectId.isValid(query.managerId)
      ? query.managerId
      : reqUser.userId;
  const subtreeIds = await resolveSubtreeUserIds(companyId, targetId, {
    includeSelf: query.includeSelf === 'true' || query.includeSelf === true
  });
  if (!subtreeIds.length) return { docs: [], total: 0 };

  const filter = { _id: { $in: subtreeIds }, companyId };
  if (query.isActive === 'true' || query.isActive === 'false') {
    filter.isActive = query.isActive === 'true';
  }
  const term = qScalar(query.search);
  if (term) {
    const rx = escapeRegex(term);
    filter.$or = [
      { name: { $regex: rx, $options: 'i' } },
      { email: { $regex: rx, $options: 'i' } },
      { employeeCode: { $regex: rx, $options: 'i' } }
    ];
  }
  const docs = await User.find(filter)
    .sort({ name: 1 })
    .populate('roleId', 'name code')
    .populate('managerId', 'name email')
    .populate('territoryId', 'name code kind')
    .lean();
  return { docs, total: docs.length };
};

/** GET /users/:id/reports — direct reports of the given user. */
const listDirectReports = async (companyId, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, 'Invalid id format');
  }
  const docs = await User.find({ companyId, managerId: id })
    .sort({ name: 1 })
    .populate('roleId', 'name code')
    .populate('territoryId', 'name code kind')
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
  user.territoryId = await resolveTerritoryRef(companyId, territoryId);
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
