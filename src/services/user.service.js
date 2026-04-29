const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex, qScalar, applyCreatedAtRangeFromQuery, applyCreatedByFromQuery } = require('../utils/listQuery');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/enums');
const { ADMIN_ACCESS } = require('../constants/rbac');
const auditService = require('./audit.service');

const normalizeEmail = (e) => (e == null || e === '' ? '' : String(e).toLowerCase().trim());

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

const list = async (companyId, query) => {
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
  applyCreatedAtRangeFromQuery(filter, query);
  applyCreatedByFromQuery(filter, query);

  const [docs, total] = await Promise.all([
    User.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('roleId', 'name code isSystem'),
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
  const user = await User.findOne({ _id: id, companyId }).populate('roleId', 'name code isSystem permissions');
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

module.exports = { list, create, getById, update, setStatus };
