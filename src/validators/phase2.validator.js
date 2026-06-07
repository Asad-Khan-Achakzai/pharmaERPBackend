const Joi = require('joi');

const createAnnouncementSchema = Joi.object({
  title: Joi.string().required().trim().max(200),
  body: Joi.string().required().trim().max(5000),
  publish: Joi.boolean().default(false)
});

const heartbeatSchema = Joi.object({
  lat: Joi.number().required().min(-90).max(90),
  lng: Joi.number().required().min(-180).max(180),
  accuracy: Joi.number().min(0).max(5000).allow(null),
  capturedAt: Joi.date().iso().allow(null),
  clientUuid: Joi.string().trim().max(64).allow(null, '')
});

const optimizeRouteSchema = Joi.object({
  date: Joi.string().required().trim(),
  startLat: Joi.number().min(-90).max(90).allow(null),
  startLng: Joi.number().min(-180).max(180).allow(null),
  itemCoordinates: Joi.object()
    .pattern(Joi.string(), Joi.object({ lat: Joi.number().required(), lng: Joi.number().required() }))
    .default({})
});

const rejectExpenseSchema = Joi.object({
  reason: Joi.string().required().trim().min(3).max(500)
});

module.exports = {
  createAnnouncementSchema,
  heartbeatSchema,
  optimizeRouteSchema,
  rejectExpenseSchema
};
