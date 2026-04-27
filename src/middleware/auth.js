const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const asyncHandler = require('./asyncHandler');
const { normalizeAccessPayload, effectiveUserType } = require('../utils/jwtAccess');

/**
 * Verifies access JWT and loads user. Does NOT set `req.companyId` or full permissions
 * (that happens in `companyScope` for business routes). Populates `req.jwtAccess` for getMe and scope.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required');
  }

  const token = authHeader.split(' ')[1];
  let rawDecoded;
  try {
    rawDecoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (e) {
    throw new ApiError(401, 'Authentication required');
  }

  const normalized = normalizeAccessPayload(rawDecoded);
  if (!normalized) {
    throw new ApiError(401, 'Authentication required');
  }

  const user = await User.findById(normalized.userId).select('+permissions').lean();
  if (!user) {
    throw new ApiError(401, 'Authentication required');
  }
  if (!user.isActive) {
    throw new ApiError(401, 'Your account is deactivated. Please contact an administrator.');
  }

  req.jwtAccess = normalized;
  const ut = effectiveUserType(user);
  req.user = {
    userId: user._id,
    companyId: user.companyId,
    homeCompanyId: user.companyId,
    userType: String(ut),
    role: user.role,
    roleId: user.roleId || null,
    name: user.name,
    email: user.email,
    activeCompanyId: user.activeCompanyId || null,
    _fromDb: user,
    permissions: []
  };

  next();
});

module.exports = { authenticate };
