const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const { USER_TYPES } = require('../constants/enums');
const { effectiveUserType } = require('../utils/jwtAccess');
const asyncHandler = require('./asyncHandler');

const requirePlatform = asyncHandler(async (req, _res, next) => {
  if (!req.user?.userId) {
    return next(new ApiError(401, 'Authentication required'));
  }
  const user = await User.findById(req.user.userId).lean();
  if (!user) {
    return next(new ApiError(401, 'Authentication required'));
  }
  if (effectiveUserType(user) !== USER_TYPES.PLATFORM) {
    return next(new ApiError(403, 'Platform access required'));
  }
  next();
});

module.exports = { requirePlatform };
