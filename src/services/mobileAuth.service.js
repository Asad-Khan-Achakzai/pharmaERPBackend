const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const Company = require('../models/Company');
const DeviceSession = require('../models/DeviceSession');
const { generateTokens } = require('./auth.tokens');
const { formatUserForClient } = require('../utils/authUserPayload');
const { effectiveUserType, normalizeAccessPayload } = require('../utils/jwtAccess');
const { hasAccessToCompany } = require('../utils/platformAccess.util');
const { hashRefreshToken } = require('../middleware/clientUuid');
const { USER_TYPES } = require('../constants/enums');
const deviceControlService = require('./deviceControl.service');

/**
 * Mobile auth service. Issues per-device refresh tokens that are tracked in
 * the `DeviceSession` collection so multiple devices (and the web app on the
 * legacy `User.refreshToken`) coexist without colliding.
 *
 * Web auth is intentionally untouched: this file only owns mobile flows.
 */

function describeDevice(device) {
  if (!device || typeof device !== 'object') {
    throw new ApiError(400, 'device payload is required');
  }
  const deviceId = String(device.deviceId || '').trim();
  if (!deviceId) throw new ApiError(400, 'device.deviceId is required');
  const platform = String(device.platform || '').toLowerCase();
  if (!['ios', 'android', 'web'].includes(platform)) {
    throw new ApiError(400, 'device.platform must be ios | android | web');
  }
  return {
    deviceId,
    platform,
    brand: device.brand ? String(device.brand).slice(0, 64) : null,
    model: device.model ? String(device.model).slice(0, 64) : null,
    osVersion: device.osVersion ? String(device.osVersion).slice(0, 32) : null,
    appVersion: device.appVersion ? String(device.appVersion).slice(0, 32) : null
  };
}

async function issueDeviceSession({ user, companyId, device }) {
  const tokens = generateTokens({
    userId: user._id,
    userType: effectiveUserType(user),
    tenantCompanyId: companyId ? String(companyId) : null,
    homeCompanyId: user.companyId
  });
  const refreshTokenHash = hashRefreshToken(tokens.refreshToken);
  await DeviceSession.findOneAndUpdate(
    { userId: user._id, deviceId: device.deviceId },
    {
      $set: {
        companyId,
        userId: user._id,
        deviceId: device.deviceId,
        platform: device.platform,
        brand: device.brand,
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        refreshTokenHash,
        lastSeenAt: new Date(),
        revokedAt: null,
        revokedReason: null
      }
    },
    { upsert: true, new: true }
  );
  return tokens;
}

async function login({ email, password, device, ip }) {
  const dev = describeDevice(device);
  const emailNorm = email ? String(email).toLowerCase().trim() : '';
  const user = await User.findOne({ email: emailNorm }).select('+password');
  if (!user) throw new ApiError(401, 'Invalid email or password');
  if (!user.isActive) {
    throw new ApiError(403, 'Your account is deactivated. Please contact an administrator.');
  }
  const ok = await user.comparePassword(password);
  if (!ok) throw new ApiError(401, 'Invalid email or password');

  user.lastLoginAt = new Date();
  if (ip) user.lastLoginIP = ip;
  await user.save();

  const ut = effectiveUserType(user);
  let activeCompanyId;
  if (ut === USER_TYPES.COMPANY) {
    activeCompanyId = user.companyId;
  } else {
    activeCompanyId = user.activeCompanyId || null;
  }

  const company = activeCompanyId
    ? await Company.findById(activeCompanyId)
        .select(
          'name mobilePushEnabled mobileEnabled attendanceGeofenceEnabled doctorApprovalRequired deviceControlEnabled'
        )
        .lean()
    : null;

  // Device Control gate (feature flag + field-force rep only). Throws
  // DEVICE_NOT_REGISTERED before any session is issued when blocked.
  if (company && company.deviceControlEnabled && (await deviceControlService.appliesToUser(user))) {
    await deviceControlService.enforceLoginBinding({ user, company, device: dev });
  }

  const tokens = await issueDeviceSession({ user, companyId: activeCompanyId, device: dev });

  const u = await formatUserForClient(user._id, {
    resolvedTenantCompanyId: activeCompanyId ? String(activeCompanyId) : null
  });
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: u,
    company: company
      ? {
          _id: company._id,
          name: company.name,
          status: 'LIVE',
          mobileEnabled: company.mobileEnabled !== false,
          mobilePushEnabled: !!company.mobilePushEnabled,
          attendanceGeofenceEnabled: !!company.attendanceGeofenceEnabled,
          doctorApprovalRequired: !!company.doctorApprovalRequired,
          deviceControlEnabled: !!company.deviceControlEnabled
        }
      : null
  };
}

async function registerDevice({ user, device }) {
  const dev = describeDevice(device);
  await DeviceSession.findOneAndUpdate(
    { userId: user.userId, deviceId: dev.deviceId },
    {
      $set: {
        companyId: user.companyId,
        userId: user.userId,
        deviceId: dev.deviceId,
        platform: dev.platform,
        brand: dev.brand,
        model: dev.model,
        osVersion: dev.osVersion,
        appVersion: dev.appVersion,
        lastSeenAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const session = await DeviceSession.findOne({
    userId: user.userId,
    deviceId: dev.deviceId
  }).lean();
  return { session };
}

async function refresh({ refreshToken, deviceId }) {
  if (!refreshToken || !deviceId) {
    throw new ApiError(400, 'refreshToken and deviceId are required');
  }
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    throw new ApiError(401, 'Invalid refresh token');
  }
  const normalized = normalizeAccessPayload(decoded);
  if (!normalized) throw new ApiError(401, 'Invalid refresh token');

  const hash = hashRefreshToken(refreshToken);
  const session = await DeviceSession.findOne({
    userId: normalized.userId,
    deviceId,
    refreshTokenHash: hash,
    revokedAt: null
  });
  if (!session) throw new ApiError(401, 'Invalid refresh token');

  const user = await User.findById(normalized.userId);
  if (!user || !user.isActive) {
    session.revokedAt = new Date();
    session.revokedReason = 'USER_INACTIVE';
    await session.save();
    throw new ApiError(401, 'Account no longer active');
  }

  const ut = effectiveUserType(user);
  let companyId = session.companyId;
  if (ut === USER_TYPES.PLATFORM && normalized.tenantCompanyId) {
    if (!(await hasAccessToCompany(user, normalized.tenantCompanyId))) {
      session.revokedAt = new Date();
      session.revokedReason = 'COMPANY_ACCESS_REVOKED';
      await session.save();
      throw new ApiError(403, 'Company access revoked');
    }
    companyId = normalized.tenantCompanyId;
  }

  const tokens = generateTokens({
    userId: user._id,
    userType: ut,
    tenantCompanyId: companyId ? String(companyId) : null,
    homeCompanyId: user.companyId
  });
  session.refreshTokenHash = hashRefreshToken(tokens.refreshToken);
  session.lastSeenAt = new Date();
  await session.save();

  return tokens;
}

async function logout({ user, deviceId }) {
  if (!deviceId) return;
  await DeviceSession.findOneAndUpdate(
    { userId: user.userId, deviceId },
    { $set: { revokedAt: new Date(), revokedReason: 'USER_LOGOUT' } }
  );
}

async function listSessions({ user }) {
  const docs = await DeviceSession.find({ userId: user.userId, revokedAt: null })
    .sort({ lastSeenAt: -1 })
    .lean();
  return docs.map((d) => ({
    _id: d._id,
    deviceId: d.deviceId,
    platform: d.platform,
    brand: d.brand,
    model: d.model,
    osVersion: d.osVersion,
    appVersion: d.appVersion,
    lastSeenAt: d.lastSeenAt
  }));
}

async function revokeSession({ user, sessionId }) {
  const doc = await DeviceSession.findOneAndUpdate(
    { _id: sessionId, userId: user.userId },
    { $set: { revokedAt: new Date(), revokedReason: 'USER_REVOKE' } },
    { new: true }
  );
  if (!doc) throw new ApiError(404, 'Session not found');
}

async function updatePushToken({ user, deviceId, pushToken }) {
  if (!deviceId) throw new ApiError(400, 'deviceId is required');
  const token = pushToken ? String(pushToken).trim() : null;

  const result = await DeviceSession.findOneAndUpdate(
    { userId: user.userId, deviceId, revokedAt: null },
    { $set: { pushToken: token, lastSeenAt: new Date() } },
    { new: true }
  );

  if (!result) {
    const anySession = await DeviceSession.findOne({ userId: user.userId, deviceId }).lean();
    if (!anySession) {
      throw new ApiError(
        404,
        'No active device session for this device — log out and log in again before registering push notifications'
      );
    }
    throw new ApiError(400, 'Device session is revoked — log in again to register push notifications');
  }

  return { sessionId: result._id, pushToken: result.pushToken };
}

async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+password');
  if (!user) throw new ApiError(404, 'User not found');
  const ok = await user.comparePassword(currentPassword);
  if (!ok) throw new ApiError(400, 'Current password is incorrect');
  user.password = newPassword;
  await user.save();
  await DeviceSession.updateMany(
    { userId: user._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' } }
  );
}

async function switchCompany({ user, companyId, device }) {
  const dev = describeDevice(device);
  const userDoc = await User.findById(user.userId);
  if (!userDoc) throw new ApiError(404, 'User not found');
  if (effectiveUserType(userDoc) !== USER_TYPES.PLATFORM) {
    throw new ApiError(403, 'Only platform users can switch company');
  }
  if (!(await hasAccessToCompany(userDoc, companyId))) {
    throw new ApiError(403, 'Not allowed to access this company');
  }
  const company = await Company.findById(companyId);
  if (!company || company.isDeleted) throw new ApiError(404, 'Company not found');
  if (company.isActive === false) throw new ApiError(400, 'Company is inactive');

  userDoc.activeCompanyId = companyId;
  await userDoc.save();

  const tokens = await issueDeviceSession({ user: userDoc, companyId, device: dev });

  const u = await formatUserForClient(userDoc._id, {
    resolvedTenantCompanyId: String(companyId)
  });
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: u,
    company: { _id: company._id, name: company.name, status: 'LIVE' }
  };
}

module.exports = {
  login,
  registerDevice,
  refresh,
  logout,
  listSessions,
  revokeSession,
  updatePushToken,
  changePassword,
  switchCompany
};
