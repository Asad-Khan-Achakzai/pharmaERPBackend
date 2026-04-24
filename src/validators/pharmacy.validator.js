const Joi = require('joi');

const bonusSchemeSchema = Joi.object({
  buyQty: Joi.number().min(0).default(0),
  getQty: Joi.number().min(0).default(0)
});

const createPharmacySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100).default(0),
  bonusScheme: bonusSchemeSchema
});

const updatePharmacySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100),
  bonusScheme: bonusSchemeSchema,
  isActive: Joi.boolean()
}).min(1);

module.exports = { createPharmacySchema, updatePharmacySchema };
