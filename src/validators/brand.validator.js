const Joi = require('joi');

const createBrandSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  description: Joi.string().trim().max(2000).allow('', null),
  isActive: Joi.boolean()
});

const updateBrandSchema = createBrandSchema.fork(['name'], (s) => s.optional()).min(1);

module.exports = { createBrandSchema, updateBrandSchema };
