const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { ROLES, USER_TYPES } = require('../constants/enums');
const { generateTokens } = require('./auth.tokens');
const { seedDefaultRolesForCompany } = require('./role.service');
const { formatUserForClient } = require('../utils/authUserPayload');
const { effectiveUserType } = require('../utils/jwtAccess');
const { getPlatformAllowedCompanyIds, hasAccessToCompany } = require('../utils/platformAccess.util');
const { normalizeAccessPayload } = require('../utils/jwtAccess');
const { resolveCompanyTimeZone } = require('../utils/countryTimeZone');

const register = async ({
  companyName,
  companyEmail,
  companyPhone,
  name,
  email,
  password,
  country,
  timeZone,
  currency
}) => {
  const userEmail = email ? String(email).toLowerCase().trim() : '';
  if (userEmail) {
    const existingUser = await User.findOne({ email: userEmail });
    if (existingUser) {
      throw new ApiError(409, 'User with this email already exists');
    }
  }

  const existingCompany = await Company.findOne({ email: companyEmail });
  if (existingCompany) {
    throw new ApiError(409, 'A company with this email already exists');
  }

  const resolvedTimeZone = resolveCompanyTimeZone({ timeZone, country });
  const countryNorm = country != null ? String(country).trim().toUpperCase() : '';

  const company = await Company.create({
    name: companyName,
    email: companyEmail,
    phone: companyPhone,
    country: countryNorm || undefined,
    currency: currency || 'PKR',
    timeZone: resolvedTimeZone
  });

  const { adminRole } = await seedDefaultRolesForCompany(company._id, {});

  const user = await User.create({
    companyId: company._id,
    name,
    email: userEmail,
    password,
    role: ROLES.ADMIN,
    roleId: adminRole._id,
    userType: USER_TYPES.COMPANY,
    permissions: []
  });

  const tokens = generateTokens({
    userId: user._id,
    userType: USER_TYPES.COMPANY,
    tenantCompanyId: company._id,
    homeCompanyId: company._id
  });
  user.refreshToken = tokens.refreshToken;
  await user.save();

  const u = await formatUserForClient(user._id, { resolvedTenantCompanyId: String(company._id) });
  return { user: u, company, tokens };
};

const runLoginPayload = async (user) => {
  const ut = effectiveUserType(user);
  if (ut === USER_TYPES.COMPANY) {
    const tokens = generateTokens({
      userId: user._id,
      userType: USER_TYPES.COMPANY,
      tenantCompanyId: user.companyId,
      homeCompanyId: user.companyId
    });
    user.refreshToken = tokens.refreshToken;
    await user.save();
    const u = await formatUserForClient(user._id, { resolvedTenantCompanyId: String(user.companyId) });
    return { user: u, tokens };
  }

  const allowedIds = await getPlatformAllowedCompanyIds(user);
  if (allowedIds.length === 0) {
    throw new ApiError(403, 'You have no access to any company. Contact your administrator.');
  }

  let tenant = null;
  if (allowedIds.length === 1) {
    [tenant] = allowedIds;
  } else if (user.activeCompanyId) {
    const a = String(user.activeCompanyId);
    if (allowedIds.includes(a)) {
      tenant = a;
    }
  }

  const tokens = generateTokens({
    userId: user._id,
    userType: USER_TYPES.PLATFORM,
    tenantCompanyId: tenant,
    homeCompanyId: user.companyId
  });
  user.refreshToken = tokens.refreshToken;
  if (tenant) {
    user.activeCompanyId = tenant;
  }
  await user.save();
  const u = await formatUserForClient(user._id, { resolvedTenantCompanyId: tenant || null });
  return { user: u, tokens };
};

const login = async (email, password, ip) => {
  const emailNorm = email ? String(email).toLowerCase().trim() : '';
  const user = await User.findOne({ email: emailNorm }).select('+password +refreshToken');
  if (!user) {
    throw new ApiError(401, 'Invalid email or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Your account is deactivated. Please contact an administrator.');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new ApiError(401, 'Invalid email or password');
  }

  user.lastLoginAt = new Date();
  if (ip) user.lastLoginIP = ip;

  return runLoginPayload(user);
};

const refreshToken = async (token) => {
  if (!token) {
    throw new ApiError(401, 'Refresh token required');
  }

  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
  const normalized = normalizeAccessPayload(decoded);
  if (!normalized) {
    throw new ApiError(401, 'Invalid refresh token');
  }

  const user = await User.findById(normalized.userId).select('+refreshToken');
  if (!user || user.refreshToken !== token) {
    throw new ApiError(401, 'Invalid refresh token');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Your account is deactivated. Please contact an administrator.');
  }

  const ut = effectiveUserType(user);
  if (ut === USER_TYPES.COMPANY) {
    const tokens = generateTokens({
      userId: user._id,
      userType: USER_TYPES.COMPANY,
      tenantCompanyId: user.companyId,
      homeCompanyId: user.companyId
    });
    user.refreshToken = tokens.refreshToken;
    await user.save();
    return tokens;
  }

  if (!normalized.tenantCompanyId) {
    const tokens = generateTokens({
      userId: user._id,
      userType: USER_TYPES.PLATFORM,
      tenantCompanyId: null,
      homeCompanyId: user.companyId
    });
    user.refreshToken = tokens.refreshToken;
    await user.save();
    return tokens;
  }

  if (!(await hasAccessToCompany(user, normalized.tenantCompanyId))) {
    throw new ApiError(403, 'Access to selected company is no longer valid. Please sign in again.');
  }

  const tokens = generateTokens({
    userId: user._id,
    userType: USER_TYPES.PLATFORM,
    tenantCompanyId: normalized.tenantCompanyId,
    homeCompanyId: user.companyId
  });
  user.refreshToken = tokens.refreshToken;
  await user.save();
  return tokens;
};

const getMe = async (userId, jwtAccess) => {
  const user = await User.findById(userId).lean();
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  const ut = effectiveUserType(user);
  let resolved = null;
  if (ut === USER_TYPES.COMPANY) {
    resolved = String(user.companyId);
  } else if (jwtAccess && jwtAccess.tenantCompanyId) {
    resolved = String(jwtAccess.tenantCompanyId);
  }
  const u = await formatUserForClient(userId, { resolvedTenantCompanyId: resolved || null });
  if (!u) {
    throw new ApiError(404, 'User not found');
  }
  return u;
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    throw new ApiError(400, 'Current password is incorrect');
  }

  user.password = newPassword;
  await user.save();
};

const switchCompany = async (userId, companyId) => {
  const user = await User.findById(userId).select('+refreshToken');
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  if (effectiveUserType(user) !== USER_TYPES.PLATFORM) {
    throw new ApiError(403, 'Only platform users can switch company context.');
  }
  if (!(await hasAccessToCompany(user, companyId))) {
    throw new ApiError(403, 'Not allowed to access this company or access was revoked.');
  }
  const c = await Company.findById(companyId);
  if (!c || c.isDeleted) {
    throw new ApiError(404, 'Company not found');
  }
  if (c.isActive === false) {
    throw new ApiError(400, 'Company is inactive');
  }
  const tokens = generateTokens({
    userId: user._id,
    userType: USER_TYPES.PLATFORM,
    tenantCompanyId: String(companyId),
    homeCompanyId: user.companyId
  });
  user.refreshToken = tokens.refreshToken;
  user.activeCompanyId = companyId;
  await user.save();
  const u = await formatUserForClient(userId, { resolvedTenantCompanyId: String(companyId) });
  return {
    tokens,
    user: u,
    company: { _id: c._id, name: c.name, city: c.city, currency: c.currency }
  };
};

module.exports = { register, login, refreshToken, getMe, changePassword, switchCompany };
