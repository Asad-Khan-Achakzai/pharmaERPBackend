/** Core RBAC keys — authorization uses these, not `role` or `role.code`. */
const ADMIN_ACCESS = 'admin.access';
const ROLES_MANAGE = 'roles.manage';
const DEFAULT_ADMIN_CODE = 'DEFAULT_ADMIN';
const DEFAULT_MEDICAL_REP_CODE = 'DEFAULT_MEDICAL_REP';
/** New MRep role codes, seeded per company alongside ADMIN/MEDICAL_REP (Phase 0). */
const DEFAULT_ASM_CODE = 'DEFAULT_ASM';
const DEFAULT_RM_CODE = 'DEFAULT_RM';

/** Permission keys (string constants used by manager-scope resolver and middleware). */
const TEAM_VIEW = 'team.view';
const TEAM_MANAGE = 'team.manage';
const TEAM_VIEW_ALL_REPORTS = 'team.viewAllReports';

module.exports = {
  ADMIN_ACCESS,
  ROLES_MANAGE,
  DEFAULT_ADMIN_CODE,
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE,
  TEAM_VIEW,
  TEAM_MANAGE,
  TEAM_VIEW_ALL_REPORTS
};
