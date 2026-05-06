const Joi = require('joi');

const territoryImportPreviewSchema = Joi.object({
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null)
});

const mappingKeys = Joi.object({
  zone: Joi.string().allow(null, '').optional(),
  area: Joi.string().allow(null, '').optional(),
  brick: Joi.string().allow(null, '').optional(),
  brick_code: Joi.string().allow(null, '').optional(),
  is_active: Joi.string().allow(null, '').optional()
})
  .unknown(false)
  .required();

const territoryImportCommitSchema = Joi.object({
  fileBase64: Joi.string().required(),
  sheet: Joi.string().allow('', null),
  mapping: mappingKeys,
  skipExisting: Joi.boolean().default(true)
});

module.exports = { territoryImportPreviewSchema, territoryImportCommitSchema };
