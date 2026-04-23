const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/enums');

/**
 * Admin: always allowed. Medical rep: allowed (field staff) without DB permission rows.
 * Others: must have the given permission string.
 */
const adminRepOrPermission = (permission) => (req, _res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (req.user.role === ROLES.ADMIN || req.user.role === ROLES.SUPER_ADMIN) return next();
  if (req.user.role === ROLES.MEDICAL_REP) return next();
  const perms = req.user.permissions || [];
  if (perms.includes(permission)) return next();
  return next(new ApiError(403, 'Insufficient permissions'));
};

module.exports = { adminRepOrPermission };
