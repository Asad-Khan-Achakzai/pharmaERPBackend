const Joi = require('joi');

const latitude = Joi.number().min(-90).max(90).messages({
  'number.base': 'Latitude must be a valid decimal coordinate',
  'number.min': 'Latitude must be between -90 and 90',
  'number.max': 'Latitude must be between -90 and 90'
});

const longitude = Joi.number().min(-180).max(180).messages({
  'number.base': 'Longitude must be a valid decimal coordinate',
  'number.min': 'Longitude must be between -180 and 180',
  'number.max': 'Longitude must be between -180 and 180'
});

const createCallPointSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  latitude: latitude.required(),
  longitude: longitude.required(),
  isActive: Joi.boolean()
});

const updateCallPointSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  latitude,
  longitude,
  isActive: Joi.boolean()
}).min(1);

module.exports = { createCallPointSchema, updateCallPointSchema };
