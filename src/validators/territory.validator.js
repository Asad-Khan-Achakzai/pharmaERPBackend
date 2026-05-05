const Joi = require('joi');
const { TERRITORY_KIND } = require('../constants/enums');

const territoryBodyFields = {
  name: Joi.string().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  kind: Joi.string().valid(...Object.values(TERRITORY_KIND)),
  parentId: Joi.string().hex().length(24).allow(null, ''),
  isActive: Joi.boolean(),
  notes: Joi.string().trim().max(500).allow('', null)
};

const createTerritorySchema = Joi.object({
  ...territoryBodyFields,
  name: Joi.string().required().trim().min(1).max(200),
  kind: Joi.string()
    .valid(...Object.values(TERRITORY_KIND))
    .required(),
  parentId: Joi.string().hex().length(24).allow(null, '')
});

const updateTerritorySchema = Joi.object({
  ...territoryBodyFields
}).min(1);

module.exports = { createTerritorySchema, updateTerritorySchema };
