const Joi = require('joi');

const { ATTENDANCE_SYSTEM_MODE } = require('../constants/enums');
const { geoPlatformSchema } = require('../geo/validators/geo.validator');

const checkInPolicySchema = Joi.object({
  type: Joi.string().valid('COMPANY_DEFAULT').default('COMPANY_DEFAULT'),
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  radiusMeters: Joi.number().integer().min(25).max(5000).default(150),
  locationName: Joi.string().trim().max(200).allow('')
});

/** Per-company temporary-file retention (days). null = never delete. */
const retentionDays = () => Joi.number().integer().min(1).max(3650).allow(null);

const mediaRetentionSchema = Joi.object({
  checkinRetentionDays: retentionDays(),
  visitRetentionDays: retentionDays(),
  expenseReceiptRetentionDays: retentionDays()
});

/** Per-company media enable overrides. null = inherit env default. */
const mediaFlagFields = {
  mediaUploadEnabled: Joi.boolean().allow(null),
  visitPhotosEnabled: Joi.boolean().allow(null),
  expenseReceiptsEnabled: Joi.boolean().allow(null),
  productMediaEnabled: Joi.boolean().allow(null),
  mediaRetention: mediaRetentionSchema
};

const createCompanySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow('', null),
  city: Joi.string().trim().allow('', null),
  state: Joi.string().trim().allow('', null),
  country: Joi.string().trim().default('Pakistan'),
  phone: Joi.string().trim().allow('', null),
  ntnNo: Joi.string().trim().allow('', null).max(64),
  email: Joi.string().email().trim().lowercase().allow('', null),
  currency: Joi.string().trim().default('PKR'),
  timeZone: Joi.string().trim().allow('', null),
  weeklyPlanApprovalRequired: Joi.boolean(),
  strictVisitSequence: Joi.boolean(),
  mrepMultiTerritory: Joi.boolean(),
  mrepOwnershipAudit: Joi.boolean(),
  liveTrackingEnabled: Joi.boolean(),
  mobilePushEnabled: Joi.boolean(),
  deviceControlEnabled: Joi.boolean(),
  expenseApprovalRequired: Joi.boolean(),
  geoFencingEnabled: Joi.boolean(),
  geoFenceRadiusMeters: Joi.number().integer().min(25).max(5000),
  geoFenceMode: Joi.string().valid('OFF', 'SOFT', 'STRICT'),
  onboardingEnabled: Joi.boolean(),
  onboardingStrictValidation: Joi.boolean(),
  onboardingKillSwitch: Joi.boolean(),
  onboardingPilotCohort: Joi.string().trim().allow('', null).max(64),
  isActive: Joi.boolean().default(true),
  attendanceSystemMode: Joi.string().valid(...Object.values(ATTENDANCE_SYSTEM_MODE)),
  checkInPolicy: checkInPolicySchema,
  geoPlatform: geoPlatformSchema,
  ...mediaFlagFields
});

const updateCompanySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  address: Joi.string().trim().allow('', null),
  city: Joi.string().trim().allow('', null),
  state: Joi.string().trim().allow('', null),
  country: Joi.string().trim(),
  phone: Joi.string().trim().allow('', null),
  ntnNo: Joi.string().trim().allow('', null).max(64),
  email: Joi.string().email().trim().lowercase().allow('', null),
  currency: Joi.string().trim(),
  timeZone: Joi.string().trim().allow('', null),
  weeklyPlanApprovalRequired: Joi.boolean(),
  strictVisitSequence: Joi.boolean(),
  mrepMultiTerritory: Joi.boolean(),
  mrepOwnershipAudit: Joi.boolean(),
  liveTrackingEnabled: Joi.boolean(),
  mobilePushEnabled: Joi.boolean(),
  deviceControlEnabled: Joi.boolean(),
  expenseApprovalRequired: Joi.boolean(),
  geoFencingEnabled: Joi.boolean(),
  geoFenceRadiusMeters: Joi.number().integer().min(25).max(5000),
  geoFenceMode: Joi.string().valid('OFF', 'SOFT', 'STRICT'),
  onboardingEnabled: Joi.boolean(),
  onboardingStrictValidation: Joi.boolean(),
  onboardingKillSwitch: Joi.boolean(),
  onboardingPilotCohort: Joi.string().trim().allow('', null).max(64),
  isActive: Joi.boolean(),
  attendanceSystemMode: Joi.string().valid(...Object.values(ATTENDANCE_SYSTEM_MODE)),
  checkInPolicy: checkInPolicySchema,
  geoPlatform: geoPlatformSchema,
  ...mediaFlagFields
})
  .min(1)
  .unknown(false);

const switchCompanySchema = Joi.object({
  companyId: Joi.string().hex().length(24).required()
});

const objectId24 = () => Joi.string().hex().length(24);

const listPlatformUsersQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  search: Joi.string().allow(''),
  isActive: Joi.string().valid('true', 'false', '').allow(null),
  sortBy: Joi.string(),
  sortOrder: Joi.string().valid('asc', 'desc')
});

const createPlatformUserBodySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  email: Joi.string().email().required().trim().lowercase(),
  password: Joi.string().required().min(6).max(128),
  isActive: Joi.boolean().default(true),
  companyIds: Joi.array().items(objectId24()).min(1).required(),
  homeCompanyId: objectId24().optional()
});

const updatePlatformUserBodySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  email: Joi.string().email().trim().lowercase(),
  password: Joi.string().min(6).max(128).allow('', null),
  isActive: Joi.boolean(),
  companyIds: Joi.array().items(objectId24()).min(1),
  homeCompanyId: objectId24().allow(null, '').optional()
})
  .min(1)
  .unknown(false);

module.exports = {
  createCompanySchema,
  updateCompanySchema,
  switchCompanySchema,
  listPlatformUsersQuerySchema,
  createPlatformUserBodySchema,
  updatePlatformUserBodySchema
};
