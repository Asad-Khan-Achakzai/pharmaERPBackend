const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/enums');

/**
 * After `resolveHomePermissions`. Allows SUPER_ADMIN, or the explicit
 * `platform.companies.manage` on the resolved role.
 * Intentionally does not use `userHasPermission` / `admin.access` (that would let
 * every default company admin list all companies and manage platform users).
 */
const requireSuperAdminOrPlatformCompaniesManage = (req, _res, next) => {
  if (req.user?.role === ROLES.SUPER_ADMIN) {
    return next();
  }
  const p = req.user?.permissions || [];
  if (p.includes('platform.companies.manage')) {
    return next();
  }
  return next(new ApiError(403, 'Super admin or platform companies manage permission required'));
};

module.exports = { requireSuperAdminOrPlatformCompaniesManage };
