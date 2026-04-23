const Joi = require('joi');

const createCompanySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow('', null),
  city: Joi.string().trim().allow('', null),
  state: Joi.string().trim().allow('', null),
  country: Joi.string().trim().default('Pakistan'),
  phone: Joi.string().trim().allow('', null),
  email: Joi.string().email().trim().lowercase().allow('', null),
  currency: Joi.string().trim().default('PKR'),
  isActive: Joi.boolean().default(true)
});

const updateCompanySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  address: Joi.string().trim().allow('', null),
  city: Joi.string().trim().allow('', null),
  state: Joi.string().trim().allow('', null),
  country: Joi.string().trim(),
  phone: Joi.string().trim().allow('', null),
  email: Joi.string().email().trim().lowercase().allow('', null),
  currency: Joi.string().trim(),
  isActive: Joi.boolean()
})
  .min(1)
  .unknown(false);

const switchCompanySchema = Joi.object({
  companyId: Joi.string().hex().length(24).required()
});

module.exports = { createCompanySchema, updateCompanySchema, switchCompanySchema };
