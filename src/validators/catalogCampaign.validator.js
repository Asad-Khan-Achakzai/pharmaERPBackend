const Joi = require('joi');
const { CAMPAIGN_TYPES } = require('../models/CatalogCampaign');

const createCampaignSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  code: Joi.string().trim().max(64).allow('', null),
  type: Joi.string()
    .valid(...CAMPAIGN_TYPES)
    .default('FEATURED'),
  description: Joi.string().trim().max(2000).allow('', null),
  bannerAssetId: Joi.string().hex().length(24).allow(null, ''),
  productIds: Joi.array().items(Joi.string().hex().length(24)).default([]),
  startAt: Joi.date().iso().allow(null),
  endAt: Joi.date().iso().allow(null),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer()
});

const updateCampaignSchema = createCampaignSchema.fork(['name'], (s) => s.optional()).min(1);

module.exports = { createCampaignSchema, updateCampaignSchema };
