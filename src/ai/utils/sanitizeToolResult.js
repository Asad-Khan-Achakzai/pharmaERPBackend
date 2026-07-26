const { userHasPermission } = require('../../utils/effectivePermissions');

const SENSITIVE_KEYS = new Set(['password', 'refreshToken', 'logoBase64', 'costPrice']);

/** Normalize ctx into the shape expected by userHasPermission. */
function resolveReqUser(ctx) {
  if (ctx.user) {
    const perms = ctx.user.permissions;
    if (Array.isArray(perms)) return ctx.user;
    return { ...ctx.user, permissions: Array.isArray(ctx.permissions) ? ctx.permissions : [] };
  }
  return { permissions: Array.isArray(ctx.permissions) ? ctx.permissions : [] };
}

function stripSensitive(obj, reqUser) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => stripSensitive(item, reqUser));
  }
  if (typeof obj !== 'object') return obj;

  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (key === 'tp' || key === 'costPrice' || key === 'viewCostPrice') {
      if (!userHasPermission(reqUser, 'products.viewCostPrice')) continue;
    }
    out[key] = stripSensitive(val, reqUser);
  }
  return out;
}

function truncateJson(obj, maxChars = 6000) {
  const str = JSON.stringify(obj);
  if (str.length <= maxChars) return obj;
  return {
    truncated: true,
    preview: str.slice(0, maxChars),
    message: 'Result truncated for context size. Narrow your query or ask for a summary.'
  };
}

function sanitizeToolResult(result, ctx) {
  const reqUser = resolveReqUser(ctx);
  const cleaned = stripSensitive(result, reqUser);
  return truncateJson(cleaned);
}

module.exports = { sanitizeToolResult, stripSensitive, truncateJson, resolveReqUser };
