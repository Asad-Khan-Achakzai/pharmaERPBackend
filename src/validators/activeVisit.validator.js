const Joi = require('joi');

const activeVisitPayloadSchema = Joi.object({
  notes: Joi.string().allow(''),
  mood: Joi.string().allow('', null),
  productIds: Joi.array().items(Joi.string()).max(50),
  primaryProductId: Joi.string().allow(null, ''),
  samples: Joi.object().pattern(Joi.string(), Joi.number().integer().min(0)),
  orderTaken: Joi.boolean(),
  followUpDate: Joi.string().allow('', null),
  outOfOrderReason: Joi.string().allow('', null),
  unplannedReason: Joi.string().allow('', null),
  visitStarted: Joi.boolean()
}).unknown(true);

const upsertActiveVisitSchema = Joi.object({
  clientUuid: Joi.string().trim().max(64).required(),
  planItemId: Joi.string().hex().length(24).allow(null, ''),
  doctorId: Joi.string().hex().length(24).required(),
  startedAt: Joi.alternatives().try(Joi.date(), Joi.string().isoDate(), Joi.string()).required(),
  visitStarted: Joi.boolean(),
  payload: activeVisitPayloadSchema.default({})
});

const listActiveVisitQuerySchema = Joi.object({
  employeeId: Joi.string().hex().length(24)
});

module.exports = {
  upsertActiveVisitSchema,
  listActiveVisitQuerySchema
};
