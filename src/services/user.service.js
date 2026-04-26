const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/enums');
const { ADMIN_ACCESS } = require('../constants/rbac');
const auditService = require('./audit.service');

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

  const filter = { companyId };
  if (query.role) filter.role = query.role;
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }

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

  const existing = await User.findOne({ companyId, email: data.email });
  if (existing) {
    throw new ApiError(409, 'User with this email already exists in this company');
  }

  const payload = await applyRoleIdToUserPayload(companyId, data);

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

  const before = user.toJSON();

  const payload = await applyRoleIdToUserPayload(companyId, data);
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

const remove = async (companyId, id, reqUser) => {
  const user = await User.findOne({ _id: id, companyId });
  if (!user) throw new ApiError(404, 'User not found');

  if (user._id.toString() === reqUser.userId.toString()) {
    throw new ApiError(400, 'Cannot deactivate your own account');
  }

  await user.softDelete(reqUser.userId);

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'user.delete',
    entityType: 'User',
    entityId: user._id,
    changes: { after: { isActive: false } }
  });

  return user;
};

module.exports = { list, create, getById, update, remove };
