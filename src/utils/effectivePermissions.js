const { ROLES } = require('../constants/enums');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ADMIN_ACCESS } = require('../constants/rbac');

/**
 * Resolves effective permission strings for a user. STRICT: if user.roleId is set, role.permissions ONLY (no merge).
 * @param {import('mongoose').Document|object} user - User document (needs role, roleId, companyId, permissions)
 * @param {object|null} roleDoc - Role lean doc if loaded
 * @param {boolean|string} useRoleBasedAuth - from env; if false, always legacy user.permissions
 */
const resolveEffectivePermissions = (user, roleDoc, useRoleBasedAuth) => {
  const off = useRoleBasedAuth === false || useRoleBasedAuth === '0';
  if (user.role === ROLES.SUPER_ADMIN) {
    return [...ALL_PERMISSIONS];
  }
  if (off) {
    return [...(user.permissions || [])];
  }
  if (user.roleId) {
    if (!roleDoc) return [];
    return [...(roleDoc.permissions || [])];
  }
  /** Legacy: no roleId — preserve pre-RBAC behavior until migration assigns roleId. */
  if (user.role === ROLES.ADMIN) {
    return [...ALL_PERMISSIONS];
  }
  return [...(user.permissions || [])];
};

/**
 * Check one permission. SUPER_ADMIN: all. admin.access: all catalog permissions.
 * Use only with req.user built by auth middleware (resolved `permissions` on user).
 */
const userHasPermission = (reqUser, permission) => {
  if (!reqUser) return false;
  if (reqUser.role === ROLES.SUPER_ADMIN) return true;
  const perms = reqUser.permissions || [];
  if (perms.includes(ADMIN_ACCESS)) return true;
  return perms.includes(permission);
};

const userHasEveryPermission = (reqUser, requiredPermissions) =>
  requiredPermissions.every((p) => userHasPermission(reqUser, p));

const userHasAnyPermission = (reqUser, requiredPermissions) =>
  requiredPermissions.some((p) => userHasPermission(reqUser, p));

module.exports = {
  resolveEffectivePermissions,
  userHasPermission,
  userHasEveryPermission,
  userHasAnyPermission
};
