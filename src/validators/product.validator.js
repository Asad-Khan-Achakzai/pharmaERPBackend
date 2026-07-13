const Joi = require('joi');

const objectId = Joi.string().hex().length(24);

const createProductSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  sku: Joi.string().trim().max(64).allow('', null),
  brandId: objectId.allow(null, ''),
  composition: Joi.string().trim().allow(''),
  genericName: Joi.string().trim().max(300).allow('', null),
  strength: Joi.string().trim().max(120).allow('', null),
  dosageForm: Joi.string().trim().max(120).allow('', null),
  packSize: Joi.string().trim().max(120).allow('', null),
  manufacturer: Joi.string().trim().max(200).allow('', null),
  taxonomyNodeId: objectId.allow(null, ''),
  description: Joi.string().trim().max(5000).allow('', null),
  indications: Joi.string().trim().max(5000).allow('', null),
  contraindications: Joi.string().trim().max(5000).allow('', null),
  dosageInstructions: Joi.string().trim().max(5000).allow('', null),
  sideEffects: Joi.string().trim().max(5000).allow('', null),
  storageInstructions: Joi.string().trim().max(2000).allow('', null),
  mrp: Joi.number().required().min(0),
  tp: Joi.number().required().min(0),
  tpPercent: Joi.number().min(0).max(100),
  casting: Joi.number().required().min(0),
  castingPercent: Joi.number().min(0).max(100),
  distributorPrice: Joi.number().min(0).allow(null),
  sortOrder: Joi.number().integer(),
  isSampleEligible: Joi.boolean(),
  sampleUnitLabel: Joi.string().trim().max(64).allow('', null),
  isActive: Joi.boolean(),
  assetId: Joi.string()
});

const updateProductSchema = createProductSchema.fork(
  ['name', 'mrp', 'tp', 'casting'],
  (s) => s.optional()
).min(1);

module.exports = { createProductSchema, updateProductSchema };
