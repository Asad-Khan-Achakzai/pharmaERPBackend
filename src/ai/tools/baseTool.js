const ApiError = require('../../utils/ApiError');
const { userHasPermission } = require('../../utils/effectivePermissions');

/**
 * @param {import('../utils/aiRequestContext').AiRequestContext} ctx
 * @param {string[]} requiredPermissions
 */
function assertToolPermissions(ctx, requiredPermissions) {
  if (!requiredPermissions?.length) return;
  const user = ctx.user || { permissions: ctx.permissions };
  const ok = requiredPermissions.some((p) => userHasPermission(user, p));
  if (!ok) {
    throw new ApiError(403, `You do not have permission to access this data (${requiredPermissions.join(' or ')}).`);
  }
}

/**
 * @param {object} def
 * @returns {object}
 */
function defineTool(def) {
  return {
    mutability: 'read',
    ...def,
    async execute(ctx, params) {
      assertToolPermissions(ctx, def.requiredPermissions);
      const { error, value } = def.parameters.validate(params || {}, {
        abortEarly: false,
        stripUnknown: true
      });
      if (error) {
        throw new ApiError(400, error.details.map((d) => d.message).join('; '));
      }
      return def.run(ctx, value);
    }
  };
}

module.exports = { defineTool, assertToolPermissions };
