const { USER_TYPES } = require('../constants/enums');
const { ROLES } = require('../constants/enums');

/**
 * Resolves "platform" vs "company" identity for auth.
 * NOTE: The User schema defaults `userType` to COMPANY for *all* new users, including SUPER_ADMIN.
 * We must not return COMPANY before testing SUPER_ADMIN, or legacy super admins never get platform routes.
 */
const effectiveUserType = (user) => {
  if (user.userType === USER_TYPES.PLATFORM) {
    return USER_TYPES.PLATFORM;
  }
  if (user.role === ROLES.SUPER_ADMIN) {
    return USER_TYPES.PLATFORM;
  }
  if (user.userType === USER_TYPES.COMPANY) {
    return USER_TYPES.COMPANY;
  }
  return USER_TYPES.COMPANY;
};

/**
 * Normalizes both new tokens and legacy { userId, companyId } access tokens.
 * @param {object} decoded
 */
const normalizeAccessPayload = (decoded) => {
  if (!decoded || !decoded.userId) {
    return null;
  }
  const legacy = !decoded.userType;
  if (legacy && decoded.companyId) {
    const cid = String(decoded.companyId);
    return {
      userId: String(decoded.userId),
      userType: USER_TYPES.COMPANY,
      tenantCompanyId: cid,
      homeCompanyId: cid,
      _legacy: true
    };
  }
  return {
    userId: String(decoded.userId),
    userType: decoded.userType || USER_TYPES.COMPANY,
    tenantCompanyId: decoded.tenantCompanyId != null && decoded.tenantCompanyId !== '' ? String(decoded.tenantCompanyId) : null,
    homeCompanyId: decoded.homeCompanyId != null ? String(decoded.homeCompanyId) : null,
    _legacy: false
  };
};

/** @param {import('mongoose').Document|object} user */
const isPlatformUser = (user) => effectiveUserType(user) === USER_TYPES.PLATFORM;

module.exports = { effectiveUserType, normalizeAccessPayload, isPlatformUser, USER_TYPES };
