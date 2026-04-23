const ApiError = require('../utils/ApiError');

const checkPermission = (...requiredPermissions) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }

    if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    const userPerms = req.user.permissions || [];
    const hasPermission = requiredPermissions.every((perm) => userPerms.includes(perm));

    if (!hasPermission) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }

    next();
  };
};

/** Pass if the user has at least one of the listed permissions (ADMIN / SUPER_ADMIN always pass). */
const checkPermissionAny = (...requiredPermissions) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }

    if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    const userPerms = req.user.permissions || [];
    const hasAny = requiredPermissions.some((perm) => userPerms.includes(perm));

    if (!hasAny) {
      return next(new ApiError(403, 'Insufficient permissions'));
    }

    next();
  };
};

module.exports = { checkPermission, checkPermissionAny };
