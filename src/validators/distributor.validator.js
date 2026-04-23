const Joi = require('joi');

const createDistributorSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100).default(0),
  commissionPercentOnTP: Joi.number().min(0).max(100).allow(null)
});

const updateDistributorSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  address: Joi.string().trim().allow(''),
  city: Joi.string().trim().allow(''),
  state: Joi.string().trim().allow(''),
  phone: Joi.string().trim().allow(''),
  email: Joi.string().email().trim().allow(''),
  discountOnTP: Joi.number().min(0).max(100),
  commissionPercentOnTP: Joi.number().min(0).max(100).allow(null),
  isActive: Joi.boolean()
}).min(1);

module.exports = { createDistributorSchema, updateDistributorSchema };
