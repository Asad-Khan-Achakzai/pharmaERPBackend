const Joi = require('joi');
const { PHARMACY_TAX_STATUS } = require('../constants/taxCatalog');

const bonusSchemeSchema = Joi.object({
  buyQty: Joi.number().min(0).default(0),
  getQty: Joi.number().min(0).default(0)
});

const taxFields = {
  licenseNumber: Joi.string().trim().allow('').max(128),
  licenseExpiry: Joi.date().iso().allow(null),
  licenseAuthority: Joi.string().trim().allow('').max(200),
  ntn: Joi.string().trim().allow('').max(64),
  strn: Joi.string().trim().allow('').max(64),
  taxStatus: Joi.string().valid(...Object.values(PHARMACY_TAX_STATUS)),
  taxExempt: Joi.boolean(),
  taxExemptReason: Joi.string().trim().allow('').max(500),
  taxIdentifiers: Joi.object().unknown(true).allow(null)
};

const createPharmacySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100).default(0),
  bonusScheme: bonusSchemeSchema,
  assetId: Joi.string(),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
  ...taxFields
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
  isActive: Joi.boolean(),
  assetId: Joi.string(),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
  ...taxFields
}).min(1);

module.exports = { createPharmacySchema, updatePharmacySchema };
