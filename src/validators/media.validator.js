const Joi = require('joi');
const { MEDIA_KINDS, MEDIA_RESOURCES } = require('../models/MediaAsset');

const presignSchema = Joi.object({
  kind: Joi.string()
    .valid(...MEDIA_KINDS)
    .required(),
  mime: Joi.string().required(),
  size: Joi.number().integer().min(1).max(100 * 1024 * 1024).required()
});

const finalizeSchema = Joi.object({
  assetId: Joi.string().required(),
  size: Joi.number().integer().min(1).max(50 * 1024 * 1024),
  mime: Joi.string(),
  width: Joi.number().integer().min(1),
  height: Joi.number().integer().min(1)
});

const linkSchema = Joi.object({
  resource: Joi.string()
    .valid(...MEDIA_RESOURCES)
    .required(),
  id: Joi.string().required(),
  assetIds: Joi.array().items(Joi.string()).min(1).required()
});

const attachSchema = Joi.object({
  resource: Joi.string()
    .valid(...MEDIA_RESOURCES)
    .required(),
  id: Joi.string().required(),
  assetId: Joi.string().required()
});

module.exports = { presignSchema, finalizeSchema, linkSchema, attachSchema };
