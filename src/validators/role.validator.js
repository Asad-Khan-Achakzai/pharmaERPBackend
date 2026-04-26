const Joi = require('joi');
const { ALL_PERMISSIONS } = require('../constants/permissions');

const createRoleSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  code: Joi.string().trim().max(50).allow(null, ''),
  permissions: Joi.array()
    .items(Joi.string().valid(...ALL_PERMISSIONS))
    .min(1)
    .required()
});

const updateRoleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  code: Joi.string().trim().max(50).allow(null, ''),
  permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS))
}).min(1);

module.exports = { createRoleSchema, updateRoleSchema };
