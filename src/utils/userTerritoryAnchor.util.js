const mongoose = require('mongoose');
const { TERRITORY_KIND } = require('../constants/enums');
const ApiError = require('./ApiError');
const {
  ADMIN_ACCESS,
  DEFAULT_ADMIN_CODE,
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE
} = require('../constants/rbac');

const MR_ALLOWED = new Set([TERRITORY_KIND.BRICK, TERRITORY_KIND.AREA]);
const ASM_ALLOWED = new Set([TERRITORY_KIND.AREA, TERRITORY_KIND.ZONE]);

/**
 * Ensures territory anchor kind is allowed for the user's role.
 * No schema change: territoryId may point to ZONE / AREA / BRICK; expansion is handled elsewhere.
 * Custom roles (no DEFAULT_* code in ladder) skip this check.
 */
async function validateTerritoryAnchorForRole(Role, roleId, territoryKind) {
  if (!territoryKind || !roleId || !mongoose.Types.ObjectId.isValid(roleId)) return;
  const role = await Role.findById(roleId).select('code permissions').lean();
  if (!role) {
    throw new ApiError(400, 'Role not found');
  }
  const code = role.code || '';
  const perms = Array.isArray(role.permissions) ? role.permissions : [];
  const isTenantAdmin = code === DEFAULT_ADMIN_CODE || perms.includes(ADMIN_ACCESS);
  if (isTenantAdmin || code === DEFAULT_RM_CODE) {
    return;
  }
  let allowed = null;
  let roleLabel = code;
  if (code === DEFAULT_ASM_CODE) {
    allowed = ASM_ALLOWED;
    roleLabel = 'ASM';
  } else if (code === DEFAULT_MEDICAL_REP_CODE) {
    allowed = MR_ALLOWED;
    roleLabel = 'Medical Rep';
  }
  if (!allowed) {
    return;
  }
  if (!allowed.has(territoryKind)) {
    throw new ApiError(
      400,
      `For ${roleLabel}, territory must be ${[...allowed].join(' or ')} (got ${territoryKind})`
    );
  }
}

module.exports = {
  validateTerritoryAnchorForRole
};
