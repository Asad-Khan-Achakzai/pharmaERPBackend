const Joi = require('joi');

const createProductSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  composition: Joi.string().trim().allow(''),
  mrp: Joi.number().required().min(0),
  tp: Joi.number().required().min(0),
  tpPercent: Joi.number().min(0).max(100),
  casting: Joi.number().required().min(0),
  castingPercent: Joi.number().min(0).max(100)
});

const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  composition: Joi.string().trim().allow(''),
  mrp: Joi.number().min(0),
  tp: Joi.number().min(0),
  tpPercent: Joi.number().min(0).max(100),
  casting: Joi.number().min(0),
  castingPercent: Joi.number().min(0).max(100),
  isActive: Joi.boolean()
}).min(1);

module.exports = { createProductSchema, updateProductSchema };
