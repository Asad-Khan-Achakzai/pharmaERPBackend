const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const asyncHandler = require('./asyncHandler');

const authenticate = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required');
  }

  const token = authHeader.split(' ')[1];
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);

  const user = await User.findById(decoded.userId).select('+permissions');
  if (!user || !user.isActive) {
    throw new ApiError(401, 'User not found or inactive');
  }

  req.user = {
    userId: user._id,
    companyId: user.companyId,
    activeCompanyId: user.activeCompanyId || null,
    role: user.role,
    permissions: user.permissions || [],
    name: user.name,
    email: user.email
  };

  next();
});

module.exports = { authenticate };
