const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { parsePagination } = require('../utils/pagination');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/enums');
const auditService = require('./audit.service');

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
    User.find(filter).sort(sort).skip(skip).limit(limit),
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

  if (data.role === ROLES.ADMIN) {
    data.permissions = ALL_PERMISSIONS;
  }

  const user = await User.create({ ...data, companyId, createdBy: reqUser.userId });

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
  const user = await User.findOne({ _id: id, companyId });
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

  if (data.role === ROLES.ADMIN) {
    data.permissions = ALL_PERMISSIONS;
  }

  Object.assign(user, { ...data, updatedBy: reqUser.userId });
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
