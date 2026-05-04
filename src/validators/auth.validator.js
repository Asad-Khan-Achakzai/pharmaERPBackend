const Joi = require('joi');

const registerSchema = Joi.object({
  companyName: Joi.string().required().trim().min(2).max(100),
  companyEmail: Joi.string().email().required().trim(),
  companyPhone: Joi.string().trim().allow(''),
  country: Joi.string().length(2).uppercase().required(),
  timeZone: Joi.string().trim().allow('', null),
  currency: Joi.string().trim().default('PKR'),
  name: Joi.string().required().trim().min(2).max(100),
  email: Joi.string().email().required().trim(),
  password: Joi.string().required().min(6).max(128)
});

const loginSchema = Joi.object({
  email: Joi.string().email().required().trim(),
  password: Joi.string().required()
});

const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required()
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().required().min(6).max(128)
});

const switchCompanySchema = Joi.object({
  companyId: Joi.string().required()
});

module.exports = { registerSchema, loginSchema, refreshTokenSchema, changePasswordSchema, switchCompanySchema };
