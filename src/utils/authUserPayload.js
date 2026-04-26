const User = require('../models/User');
const Role = require('../models/Role');
const env = require('../config/env');
const { ROLES } = require('../constants/enums');
const { ensureDefaultRolesForCompany } = require('../services/role.service');
const { resolveEffectivePermissions } = require('./effectivePermissions');

/**
 * Public user object for API (login, register, getMe) with **resolved** permissions.
 */
const formatUserForClient = async (userId) => {
  const user = await User.findById(userId)
    .select('+permissions')
    .populate('companyId')
    .populate('activeCompanyId')
    .populate('roleId', 'name code isSystem permissions')
    .lean();
  if (!user) return null;

  if (user.role !== ROLES.SUPER_ADMIN && user.companyId) {
    try {
      await ensureDefaultRolesForCompany(user.companyId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[authUserPayload] ensureDefaultRolesForCompany failed', err && err.message);
    }
  }

  const useRb = String(env.USE_ROLE_BASED_AUTH || '1') !== '0';
  const roleDoc =
    user.roleId && useRb
      ? await Role.findOne({ _id: user.roleId, companyId: user.companyId, isDeleted: { $ne: true } }).lean()
      : null;
  const permissions = resolveEffectivePermissions(user, roleDoc, env.USE_ROLE_BASED_AUTH);
  const { password, refreshToken, ...rest } = user;
  return { ...rest, permissions };
};

module.exports = { formatUserForClient };
