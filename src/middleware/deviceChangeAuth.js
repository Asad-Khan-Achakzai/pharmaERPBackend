const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const User = require('../models/User');
const { verifyDeviceChangeToken } = require('../services/auth.tokens');

/**
 * Authenticates the short-lived device-change token (issued at login-block time).
 * Used ONLY by the device-change-request endpoints so a rep whose device is not
 * registered can request a switch without a full session. Sets `req.deviceChange`.
 */
const deviceChangeAuth = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Device change authorization required');
  }
  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = verifyDeviceChangeToken(token);
  } catch {
    throw new ApiError(401, 'Device change session expired. Please log in again to retry.');
  }

  const user = await User.findById(decoded.userId).select('companyId role roleId isActive').lean();
  if (!user) throw new ApiError(401, 'Device change authorization required');
  if (!user.isActive) {
    throw new ApiError(403, 'Your account is deactivated. Please contact an administrator.');
  }

  req.deviceChange = {
    userId: user._id,
    companyId: decoded.companyId || user.companyId,
    deviceId: decoded.deviceId
  };
  next();
});

module.exports = { deviceChangeAuth };
