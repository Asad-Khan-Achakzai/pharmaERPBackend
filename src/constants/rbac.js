/** Core RBAC keys — authorization uses these, not `role` or `role.code`. */
const ADMIN_ACCESS = 'admin.access';
const ROLES_MANAGE = 'roles.manage';
const DEFAULT_ADMIN_CODE = 'DEFAULT_ADMIN';
const DEFAULT_MEDICAL_REP_CODE = 'DEFAULT_MEDICAL_REP';

module.exports = {
  ADMIN_ACCESS,
  ROLES_MANAGE,
  DEFAULT_ADMIN_CODE,
  DEFAULT_MEDICAL_REP_CODE
};
