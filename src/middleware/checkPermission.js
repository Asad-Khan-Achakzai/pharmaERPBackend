const ApiError = require('../utils/ApiError');
const { userHasEveryPermission, userHasAnyPermission } = require('../utils/effectivePermissions');

const checkPermission = (...requiredPermissions) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }
    if (!userHasEveryPermission(req.user, requiredPermissions)) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }
    next();
  };
};

/** Pass if the user has at least one of the listed permissions (uses resolver: admin.access / SUPER_ADMIN). */
const checkPermissionAny = (...requiredPermissions) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }
    if (!userHasAnyPermission(req.user, requiredPermissions)) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }
    next();
  };
};

/**
 * After `authenticate` + `companyScope` only. Use for dedicated `/lookup` (and similar)
 * read endpoints — not for full resource `GET /` list APIs (those stay `checkPermission` gated).
 */
const allowLookupAccess = (_req, _res, next) => next();

module.exports = { checkPermission, checkPermissionAny, allowLookupAccess };
