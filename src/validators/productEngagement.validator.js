const Joi = require('joi');
const { ENGAGEMENT_EVENT_TYPES } = require('../models/ProductEngagementEvent');

const engagementEventSchema = Joi.object({
  clientEventId: Joi.string().required().trim().max(128),
  eventType: Joi.string()
    .valid(...ENGAGEMENT_EVENT_TYPES)
    .required(),
  occurredAt: Joi.date().iso(),
  productId: Joi.string().hex().length(24).allow(null, ''),
  presentationId: Joi.string().hex().length(24).allow(null, ''),
  slideId: Joi.string().hex().length(24).allow(null, ''),
  campaignId: Joi.string().hex().length(24).allow(null, ''),
  kitId: Joi.string().hex().length(24).allow(null, ''),
  doctorId: Joi.string().hex().length(24).allow(null, ''),
  visitLogId: Joi.string().hex().length(24).allow(null, ''),
  activeVisitId: Joi.string().hex().length(24).allow(null, ''),
  meta: Joi.object().unknown(true).allow(null)
});

const ingestEngagementSchema = Joi.object({
  events: Joi.array().items(engagementEventSchema).min(1).max(100).required()
});

module.exports = { ingestEngagementSchema };
