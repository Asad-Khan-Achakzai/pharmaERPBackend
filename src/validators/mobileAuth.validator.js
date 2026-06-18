const Joi = require('joi');

const deviceSchema = Joi.object({
  deviceId: Joi.string().required().min(8).max(64),
  platform: Joi.string().valid('ios', 'android', 'web').required(),
  brand: Joi.string().allow('', null).max(64),
  model: Joi.string().allow('', null).max(64),
  osVersion: Joi.string().allow('', null).max(32),
  appVersion: Joi.string().allow('', null).max(32)
});

const mobileLoginSchema = Joi.object({
  email: Joi.string().email().required().trim(),
  password: Joi.string().required(),
  device: deviceSchema.required()
});

const registerDeviceSchema = Joi.object({
  device: deviceSchema.required()
});

const mobileRefreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
  deviceId: Joi.string().required()
});

const logoutSchema = Joi.object({
  deviceId: Joi.string().required()
});

const updatePushTokenSchema = Joi.object({
  deviceId: Joi.string().required(),
  pushToken: Joi.string().allow('', null)
});

const mobileChangePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).max(128).required()
});

const mobileSwitchCompanySchema = Joi.object({
  companyId: Joi.string().required(),
  device: deviceSchema.required()
});

const pushDiagnosticSchema = Joi.object({
  deviceId: Joi.string().allow('', null).max(64),
  platform: Joi.string().allow('', null).max(16),
  appVersion: Joi.string().allow('', null).max(32),
  step: Joi.string().required().max(64),
  result: Joi.string().required().max(64),
  detail: Joi.object().unknown(true).allow(null),
  errorMessage: Joi.string().allow('', null).max(500),
  executionEnvironment: Joi.string().allow('', null).max(32),
  projectIdPresent: Joi.boolean().allow(null)
});

module.exports = {
  deviceSchema,
  mobileLoginSchema,
  registerDeviceSchema,
  mobileRefreshSchema,
  logoutSchema,
  updatePushTokenSchema,
  mobileChangePasswordSchema,
  mobileSwitchCompanySchema,
  pushDiagnosticSchema
};
