const Joi = require('joi');

const createKitSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  description: Joi.string().trim().max(2000).allow('', null),
  productIds: Joi.array().items(Joi.string().hex().length(24)).min(2).required(),
  heroAssetId: Joi.string().hex().length(24).allow(null, ''),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer()
});

const updateKitSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  description: Joi.string().trim().max(2000).allow('', null),
  productIds: Joi.array().items(Joi.string().hex().length(24)).min(2),
  heroAssetId: Joi.string().hex().length(24).allow(null, ''),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer()
}).min(1);

module.exports = { createKitSchema, updateKitSchema };
