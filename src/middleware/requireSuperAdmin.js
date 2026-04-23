const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/enums');

/**
 * Must run after `authenticate`. Does not set company context — super-admin routes only.
 */
const requireSuperAdmin = (req, _res, next) => {
  if (!req.user || req.user.role !== ROLES.SUPER_ADMIN) {
    return next(new ApiError(403, 'Super admin access required'));
  }
  next();
};

module.exports = { requireSuperAdmin };
