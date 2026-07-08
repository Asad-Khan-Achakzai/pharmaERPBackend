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
/** ASM: area/zone hierarchy or multi-brick (primary brick + explicit extras). */
const ASM_ALLOWED = new Set([TERRITORY_KIND.BRICK, TERRITORY_KIND.AREA, TERRITORY_KIND.ZONE]);

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

/**
 * Validates extra coverage territory kinds against primary anchor and role.
 * @param {import('mongoose').Model} Role
 * @param {import('mongoose').Types.ObjectId|string} roleId
 * @param {string} primaryKind - TERRITORY_KIND of territoryId
 * @param {Array<{ kind?: string }>} coverageDocs - populated or lean territory docs
 */
async function validateCoverageTerritoryKindsForRole(Role, roleId, primaryKind, coverageDocs) {
  if (!roleId || !primaryKind || !Array.isArray(coverageDocs) || !coverageDocs.length) return;

  const role = await Role.findById(roleId).select('code permissions').lean();
  if (!role) {
    throw new ApiError(400, 'Role not found');
  }
  const code = role.code || '';
  const perms = Array.isArray(role.permissions) ? role.permissions : [];
  const isTenantAdmin = code === DEFAULT_ADMIN_CODE || perms.includes(ADMIN_ACCESS);
  if (isTenantAdmin) return;

  const extras = coverageDocs.filter((d) => d && d.kind);
  if (!extras.length) return;

  const hasKind = (kind) => extras.some((d) => d.kind === kind);

  if (primaryKind === TERRITORY_KIND.AREA) {
    if (hasKind(TERRITORY_KIND.ZONE)) {
      throw new ApiError(
        400,
        'When primary territory is an area, extra coverage cannot include zone nodes (use Entire Zone strategy instead)'
      );
    }
    const invalid = extras.filter((d) => d.kind !== TERRITORY_KIND.AREA && d.kind !== TERRITORY_KIND.BRICK);
    if (invalid.length) {
      throw new ApiError(400, 'Extra coverage for area assignment must be areas or bricks only');
    }
    return;
  }

  if (primaryKind === TERRITORY_KIND.ZONE) {
    if (hasKind(TERRITORY_KIND.AREA)) {
      throw new ApiError(
        400,
        'When primary territory is a zone, extra coverage cannot include area nodes (add zones or bricks instead)'
      );
    }
    const invalid = extras.filter((d) => d.kind !== TERRITORY_KIND.ZONE && d.kind !== TERRITORY_KIND.BRICK);
    if (invalid.length) {
      throw new ApiError(400, 'Extra coverage for zone assignment must be zones or bricks only');
    }
    return;
  }

  if (primaryKind === TERRITORY_KIND.BRICK) {
    const invalid = extras.filter((d) => d.kind !== TERRITORY_KIND.BRICK);
    if (invalid.length && code === DEFAULT_MEDICAL_REP_CODE) {
      throw new ApiError(400, 'For Medical Rep multi-brick assignment, extra coverage must be bricks only');
    }
  }
}

module.exports = {
  validateTerritoryAnchorForRole,
  validateCoverageTerritoryKindsForRole
};
