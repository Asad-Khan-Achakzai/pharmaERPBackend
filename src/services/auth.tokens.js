const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { USER_TYPES } = require('../constants/enums');

/**
 * @param {Object} p
 * @param {import('mongoose').Types.ObjectId|string} p.userId
 * @param {string} [p.userType] - COMPANY | PLATFORM; default COMPANY
 * @param {import('mongoose').Types.ObjectId|string|null} [p.tenantCompanyId] - active tenant for this session (null until platform user selects)
 * @param {import('mongoose').Types.ObjectId|string} [p.homeCompanyId] - user.companyId (home)
 */
const generateTokens = (p) => {
  const { userId, userType, tenantCompanyId, homeCompanyId } = p;
  const ut = userType || USER_TYPES.COMPANY;
  const home = homeCompanyId != null ? String(homeCompanyId) : null;
  const tenant = tenantCompanyId != null && tenantCompanyId !== '' ? String(tenantCompanyId) : null;
  const accessPayload = {
    userId: String(userId),
    userType: ut,
    tenantCompanyId: tenant,
    homeCompanyId: home
  };
  const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRY });
  const refreshToken = jwt.sign(
    { userId: String(userId), userType: ut, tenantCompanyId: tenant, homeCompanyId: home },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRY }
  );
  return { accessToken, refreshToken };
};

/**
 * @deprecated use generateTokens({ ... }) — kept for any dynamic requires
 * Old shape: (userId, companyId) => tenant = companyId, userType = COMPANY
 */
const generateTokensLegacy = (userId, companyId) =>
  generateTokens({
    userId,
    userType: USER_TYPES.COMPANY,
    tenantCompanyId: companyId,
    homeCompanyId: companyId
  });

module.exports = { generateTokens, generateTokensLegacy };
