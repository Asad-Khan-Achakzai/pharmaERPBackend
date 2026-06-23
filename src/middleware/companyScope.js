const ApiError = require('../utils/ApiError');
const { USER_TYPES } = require('../constants/enums');
const { resolveEffectivePermissions } = require('../utils/effectivePermissions');
const { resolveRoleDocForTenant } = require('../utils/resolveRoleForTenant');
const { effectiveUserType } = require('../utils/jwtAccess');
const User = require('../models/User');
const Company = require('../models/Company');
const { Info } = require('luxon');
const env = require('../config/env');
const { hasAccessToCompany } = require('../utils/platformAccess.util');
const { DEFAULT_MEDICAL_REP_CODE } = require('../constants/rbac');
const deviceControlService = require('../services/deviceControl.service');
const mongoose = require('mongoose');
const asyncHandler = require('./asyncHandler');

const companyScope = asyncHandler(async (req, _res, next) => {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required'));
  }
  if (!req.jwtAccess) {
    return next(new ApiError(401, 'Authentication required'));
  }

  const { jwtAccess } = req;
  const userDoc = req.user._fromDb || (await User.findById(req.user.userId).select('+permissions').lean());
  if (!userDoc) {
    return next(new ApiError(401, 'Authentication required'));
  }

  if (effectiveUserType(userDoc) === USER_TYPES.PLATFORM) {
    if (!jwtAccess.tenantCompanyId) {
      return next(
        new ApiError(403, 'No company selected. Select a company from the list or use Switch company.')
      );
    }
    const ok = await hasAccessToCompany(userDoc, jwtAccess.tenantCompanyId);
    if (!ok) {
      return next(new ApiError(403, 'Not allowed to access this company or access was revoked.'));
    }
    req.companyId = new mongoose.Types.ObjectId(String(jwtAccess.tenantCompanyId));
  } else {
    const home = String(userDoc.companyId);
    const tenant = jwtAccess.tenantCompanyId ? String(jwtAccess.tenantCompanyId) : home;
    if (tenant !== home) {
      return next(new ApiError(403, 'Invalid session'));
    }
    req.companyId = new mongoose.Types.ObjectId(home);
  }

  const company = await Company.findById(req.companyId).lean();
  if (!company) {
    return next(new ApiError(404, 'Company not found'));
  }

  const tzRaw = company.timeZone != null ? String(company.timeZone).trim() : '';
  if (!tzRaw || !Info.isValidIANAZone(tzRaw)) {
    return next(new ApiError(422, 'Company timezone is not configured. Onboarding incomplete.'));
  }

  req.context = {
    company,
    companyId: req.companyId,
    timeZone: tzRaw
  };

  const useRb = String(env.USE_ROLE_BASED_AUTH || '1') !== '0';
  const roleDoc = userDoc.roleId && useRb ? await resolveRoleDocForTenant(userDoc, req.companyId) : null;
  const permissions = resolveEffectivePermissions(userDoc, roleDoc, env.USE_ROLE_BASED_AUTH);

  req.user = {
    userId: userDoc._id,
    companyId: userDoc.companyId,
    activeCompanyId: userDoc.activeCompanyId || null,
    role: userDoc.role,
    roleId: userDoc.roleId || null,
    roleCode: roleDoc && roleDoc.code != null ? String(roleDoc.code) : null,
    permissions,
    name: userDoc.name,
    email: userDoc.email
  };

  // Hard device-control enforcement: field-force reps hitting the API from a
  // device that is no longer their bound device are cut off immediately (even
  // if their access token has not yet expired). Web requests carry no
  // X-Device-Id header and are never affected.
  const deviceIdHeader = req.get('X-Device-Id');
  if (deviceIdHeader && company.deviceControlEnabled && req.user.roleCode === DEFAULT_MEDICAL_REP_CODE) {
    const bound = await deviceControlService.isRequestDeviceBound({
      companyId: req.companyId,
      userId: userDoc._id,
      deviceId: deviceIdHeader
    });
    if (!bound) {
      const error = new ApiError(401, 'This device is no longer registered. Please log in again.');
      error.code = 'DEVICE_REBOUND';
      return next(error);
    }
  }

  next();
});

module.exports = { companyScope };
