const Joi = require('joi');

const clientContextSchema = Joi.object({
  screen: Joi.string().trim().max(120).allow('', null),
  selectedDoctorId: Joi.string().hex().length(24).allow(null),
  selectedPharmacyId: Joi.string().hex().length(24).allow(null),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null)
}).default({});

const chatBodySchema = Joi.object({
  conversationId: Joi.string().hex().length(24).allow(null),
  message: Joi.string().trim().min(1).max(8000).required(),
  context: clientContextSchema
});

const createConversationSchema = Joi.object({
  title: Joi.string().trim().max(200).allow('', null)
});

const listConversationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(50)
});

const confirmToolBodySchema = Joi.object({
  toolName: Joi.string().required(),
  parameters: Joi.object().required(),
  confirmed: Joi.boolean().valid(true).required()
});

module.exports = {
  chatBodySchema,
  createConversationSchema,
  listConversationsQuerySchema,
  confirmToolBodySchema,
  clientContextSchema
};
