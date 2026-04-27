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
