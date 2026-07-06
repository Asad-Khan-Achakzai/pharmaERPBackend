const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const asyncHandler = require('./asyncHandler');
const { normalizeAccessPayload, effectiveUserType } = require('../utils/jwtAccess');

async function loadUserFromToken(token) {
  let rawDecoded;
  try {
    rawDecoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    throw new ApiError(401, 'Authentication required');
  }

  const normalized = normalizeAccessPayload(rawDecoded);
  if (!normalized) throw new ApiError(401, 'Authentication required');

  const user = await User.findById(normalized.userId).select('+permissions').lean();
  if (!user) throw new ApiError(401, 'Authentication required');
  if (!user.isActive) {
    throw new ApiError(401, 'Your account is deactivated. Please contact an administrator.');
  }

  return { normalized, user };
}

/** SSE-friendly auth — accepts Bearer header or `?token=` query param. */
const authenticateSse = asyncHandler(async (req, _res, next) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = String(req.query.token);
  }

  if (!token) throw new ApiError(401, 'Authentication required');

  const { normalized, user } = await loadUserFromToken(token);
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

module.exports = { authenticateSse };
