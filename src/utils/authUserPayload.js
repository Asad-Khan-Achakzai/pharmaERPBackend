const User = require('../models/User');
const Role = require('../models/Role');
const Company = require('../models/Company');
const env = require('../config/env');
const { ROLES } = require('../constants/enums');
const { USER_TYPES } = require('../constants/enums');
const { ensureDefaultRolesForCompany } = require('../services/role.service');
const { resolveEffectivePermissions } = require('./effectivePermissions');
const { effectiveUserType } = require('./jwtAccess');
const { getPlatformAllowedCompanyIds } = require('./platformAccess.util');
const mongoose = require('mongoose');

/**
 * Public user object for API (login, register, getMe) with **resolved** permissions.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {object} [options]
 * @param {string|null} [options.resolvedTenantCompanyId] - active tenant for RBAC (platform) or undefined to use user.companyId
 * @param {boolean} [options.includeAllowedCompanies] - default true for platform
 */
const formatUserForClient = async (userId, options = {}) => {
  const { resolvedTenantCompanyId, includeAllowedCompanies = true } = options;
  const user = await User.findById(userId)
    .select('+permissions')
    .populate('companyId')
    .populate('activeCompanyId')
    .populate('roleId', 'name code isSystem permissions')
    .lean();
  if (!user) return null;

  if (user.role !== ROLES.SUPER_ADMIN && user.companyId) {
    const cid = user.companyId._id || user.companyId;
    try {
      await ensureDefaultRolesForCompany(cid);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[authUserPayload] ensureDefaultRolesForCompany failed', err && err.message);
    }
  }

  const useRb = String(env.USE_ROLE_BASED_AUTH || '1') !== '0';
  const userType = effectiveUserType(user);

  let companyIdForRole = user.companyId?._id || user.companyId;
  if (userType === USER_TYPES.PLATFORM && resolvedTenantCompanyId) {
    companyIdForRole = resolvedTenantCompanyId;
  }

  const roleDoc =
    user.roleId && useRb
      ? await Role.findOne({
        _id: user.roleId,
        companyId: new mongoose.Types.ObjectId(String(companyIdForRole)),
        isDeleted: { $ne: true }
      }).lean()
      : null;
  const permissions = resolveEffectivePermissions(user, roleDoc, env.USE_ROLE_BASED_AUTH);
  const { password, refreshToken, ...rest } = user;
  const out = {
    ...rest,
    permissions,
    userType
  };

  if (userType === USER_TYPES.PLATFORM && includeAllowedCompanies) {
    const ids = await getPlatformAllowedCompanyIds(user);
    const companies = await Company.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select('name city currency isActive')
      .lean();
    out.allowedCompanies = companies.map((c) => ({
      _id: c._id,
      name: c.name,
      city: c.city,
      currency: c.currency,
      isActive: c.isActive
    }));
    if (resolvedTenantCompanyId) {
      out.activeCompanyId =
        companies.find((c) => String(c._id) === String(resolvedTenantCompanyId)) || { _id: resolvedTenantCompanyId };
    } else {
      out.activeCompanyId = null;
    }
  } else {
    out.allowedCompanies = undefined;
  }

  return out;
};

module.exports = { formatUserForClient };
