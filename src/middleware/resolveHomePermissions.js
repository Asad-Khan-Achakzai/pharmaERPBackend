const User = require('../models/User');
const Role = require('../models/Role');
const env = require('../config/env');
const { resolveEffectivePermissions } = require('../utils/effectivePermissions');
const asyncHandler = require('./asyncHandler');

/**
 * Fills `req.user.permissions` using the user’s **home** `companyId` and role
 * (for routes that do not use `companyScope`, e.g. `/platform`).
 */
const resolveHomePermissions = asyncHandler(async (req, _res, next) => {
  if (!req.user?.userId) {
    return next();
  }
  const user = await User.findById(req.user.userId).select('+permissions').lean();
  if (!user) {
    return next();
  }
  const useRb = String(env.USE_ROLE_BASED_AUTH || '1') !== '0';
  let roleDoc = null;
  if (user.roleId && useRb) {
    roleDoc = await Role.findOne({
      _id: user.roleId,
      companyId: user.companyId,
      isDeleted: { $ne: true }
    }).lean();
  }
  const permissions = resolveEffectivePermissions(user, roleDoc, env.USE_ROLE_BASED_AUTH);
  req.user = {
    ...req.user,
    permissions,
    role: user.role,
    roleId: user.roleId
  };
  next();
});

module.exports = { resolveHomePermissions };
