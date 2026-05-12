const { ROLES } = require('../constants/enums');
const { ALL_PERMISSIONS } = require('../constants/permissions');
const { ADMIN_ACCESS, ROLES_MANAGE, DEFAULT_ADMIN_CODE } = require('../constants/rbac');

/** All catalog keys except platform.* — company admins must not inherit platform-only routes or menu keys. */
const TENANT_WIDE_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !String(p).startsWith('platform.'));

/**
 * Resolves effective permission strings for a user. STRICT: if user.roleId is set, role.permissions ONLY (no merge).
 * @param {import('mongoose').Document|object} user - User document (needs role, roleId, companyId, permissions)
 * @param {object|null} roleDoc - Role lean doc if loaded
 * @param {boolean|string} useRoleBasedAuth - from env; if false, always legacy user.permissions
 */
const resolveEffectivePermissions = (user, roleDoc, useRoleBasedAuth) => {
  const off = useRoleBasedAuth === false || useRoleBasedAuth === '0';
  if (user.role === ROLES.SUPER_ADMIN) {
    return [...new Set([...ALL_PERMISSIONS, ADMIN_ACCESS, ROLES_MANAGE])];
  }
  if (off) {
    return [...(user.permissions || [])];
  }
  if (user.roleId) {
    if (!roleDoc) return [];
    /** Company Administrator: full catalog so every module route and raw `.includes('admin.access')` checks succeed. */
    if (roleDoc.code === DEFAULT_ADMIN_CODE) {
      return [...new Set([...TENANT_WIDE_PERMISSIONS, ADMIN_ACCESS, ROLES_MANAGE])];
    }
    return [...(roleDoc.permissions || [])];
  }
  /** Legacy: no roleId — preserve pre-RBAC behavior until migration assigns roleId. */
  if (user.role === ROLES.ADMIN) {
    return [...new Set([...TENANT_WIDE_PERMISSIONS, ADMIN_ACCESS, ROLES_MANAGE])];
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
  /** Legacy company administrator (full tenant access). */
  if (reqUser.role === ROLES.ADMIN) return true;
  const perms = reqUser.permissions || [];
  if (perms.includes(ADMIN_ACCESS)) return true;
  /** Populated on req.user in companyScope for RBAC users. */
  if (reqUser.roleCode === DEFAULT_ADMIN_CODE) return true;
  if (perms.includes(permission)) return true;
  /** `attendance.approve` grants both step types (enterprise shorthand). */
  if (permission === 'attendance.approve.direct' && perms.includes('attendance.approve')) return true;
  if (permission === 'attendance.approve.escalated' && perms.includes('attendance.approve')) return true;
  /** Team-scope attendance reads */
  if (permission === 'attendance.view' && perms.includes('attendance.viewTeam')) return true;
  return false;
};

const userHasEveryPermission = (reqUser, requiredPermissions) =>
  requiredPermissions.every((p) => userHasPermission(reqUser, p));

const userHasAnyPermission = (reqUser, requiredPermissions) =>
  requiredPermissions.some((p) => userHasPermission(reqUser, p));

/** True for company operators who should see tenant-wide data (not limited to their reporting subtree). */
const userHasTenantWideAccess = (reqUser) => {
  if (!reqUser) return false;
  if (reqUser.role === ROLES.SUPER_ADMIN) return true;
  if (reqUser.role === ROLES.ADMIN) return true;
  if (reqUser.roleCode === DEFAULT_ADMIN_CODE) return true;
  return (reqUser.permissions || []).includes(ADMIN_ACCESS);
};

module.exports = {
  resolveEffectivePermissions,
  userHasPermission,
  userHasEveryPermission,
  userHasAnyPermission,
  userHasTenantWideAccess
};
