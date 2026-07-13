const Joi = require('joi');
const { PRODUCT_TAXONOMY_KIND } = require('../constants/enums');

const createTaxonomySchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  kind: Joi.string()
    .valid(...Object.values(PRODUCT_TAXONOMY_KIND))
    .required(),
  parentId: Joi.string().hex().length(24).allow(null, ''),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean()
});

const updateTaxonomySchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  parentId: Joi.string().hex().length(24).allow(null, ''),
  sortOrder: Joi.number().integer(),
  isActive: Joi.boolean()
}).min(1);

module.exports = { createTaxonomySchema, updateTaxonomySchema };
