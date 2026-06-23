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

/** Short-lived token scope for device-change-request endpoints. */
const DEVICE_CHANGE_SCOPE = 'device-change';
const DEVICE_CHANGE_TOKEN_EXPIRY = '15m';

/**
 * Issued to a field-force rep when their mobile login is blocked because the
 * device is not their bound device. It only authorizes the device-change-request
 * endpoints (NOT normal APIs), so a blocked user can request a switch without a
 * full session. Signed with the access secret + a `scope` claim.
 */
const generateDeviceChangeToken = ({ userId, companyId, deviceId }) =>
  jwt.sign(
    {
      userId: String(userId),
      companyId: companyId != null ? String(companyId) : null,
      deviceId: String(deviceId),
      scope: DEVICE_CHANGE_SCOPE
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: DEVICE_CHANGE_TOKEN_EXPIRY }
  );

/** Verifies a device-change token and asserts the scope. Returns the decoded claims. */
const verifyDeviceChangeToken = (token) => {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (!decoded || decoded.scope !== DEVICE_CHANGE_SCOPE || !decoded.userId) {
    const err = new Error('Invalid device-change token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
};

module.exports = {
  generateTokens,
  generateTokensLegacy,
  generateDeviceChangeToken,
  verifyDeviceChangeToken,
  DEVICE_CHANGE_SCOPE
};
