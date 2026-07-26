const { DEFAULT_MEDICAL_REP_CODE, DEFAULT_ASM_CODE, DEFAULT_RM_CODE } = require('../../constants/rbac');
const { ROLES } = require('../../constants/enums');
const { userHasTenantWideAccess } = require('../../utils/effectivePermissions');

function resolveRoleKind(user) {
  if (!user) return 'user';
  if (user.role === ROLES.SUPER_ADMIN) return 'superadmin';
  if (userHasTenantWideAccess(user)) return 'admin';
  const code = user.roleCode || user.resolvedRole?.code;
  if (code === DEFAULT_RM_CODE || code === DEFAULT_ASM_CODE) return 'manager';
  if (user.role === ROLES.MEDICAL_REP || code === DEFAULT_MEDICAL_REP_CODE) return 'mrep';
  return 'user';
}

const ROLE_PROMPTS = {
  mrep: `## Role: Medical Representative
Focus on what helps them in the field: today's visits, pending calls, their doctors, and practical next steps on the route. Keep it actionable and easy to scan on mobile.`,

  manager: `## Role: Sales Manager (ASM/RM)
Focus on team performance, who needs attention, coverage gaps, and visit compliance. Highlight exceptions and what to act on this week.`,

  admin: `## Role: Company Administrator
Focus on company-wide operations: inventory, sales, headcount, orders. Explain what the numbers mean for the business and what to prioritize.`,

  superadmin: `## Role: Super Admin
Focus on platform and tenant-level patterns when relevant. Keep it clear and operational, not overly technical.`,

  user: `## Role: User
Adapt to their permissions. Only discuss data they can access. Stay concise and natural.`
};

function getRolePrompt(user) {
  return ROLE_PROMPTS[resolveRoleKind(user)] || ROLE_PROMPTS.user;
}

module.exports = { getRolePrompt, resolveRoleKind, ROLE_PROMPTS };
