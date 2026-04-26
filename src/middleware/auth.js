const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const Role = require('../models/Role');
const asyncHandler = require('./asyncHandler');
const { resolveEffectivePermissions } = require('../utils/effectivePermissions');

const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required');
  }

  const token = authHeader.split(' ')[1];
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);

  const user = await User.findById(decoded.userId).select('+permissions');
  if (!user) {
    throw new ApiError(401, 'Authentication required');
  }
  if (!user.isActive) {
    throw new ApiError(401, 'Your account is deactivated. Please contact an administrator.');
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
    userId: user._id,
    companyId: user.companyId,
    activeCompanyId: user.activeCompanyId || null,
    role: user.role,
    roleId: user.roleId || null,
    permissions,
    name: user.name,
    email: user.email
  };

  next();
});

module.exports = { authenticate };
