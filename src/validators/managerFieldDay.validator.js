const Joi = require('joi');

const ymd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const objectId = Joi.string().hex().length(24);

const upsertManagerFieldDaySchema = Joi.object({
  date: ymd.required(),
  medicalRepIds: Joi.array().items(objectId).max(50).required(),
  notes: Joi.string().trim().allow('').max(2000),
  /** Defaults to the caller. Admins / scoped managers may set a visible subordinate. */
  managerId: objectId.optional()
});

const updateManagerFieldDaySchema = Joi.object({
  medicalRepIds: Joi.array().items(objectId).max(50),
  notes: Joi.string().trim().allow('').max(2000)
}).min(1);

const listManagerFieldDaysQuerySchema = Joi.object({
  from: ymd.required(),
  to: ymd.required(),
  managerId: objectId.optional()
});

const meQuerySchema = Joi.object({
  date: ymd.required()
});

module.exports = {
  upsertManagerFieldDaySchema,
  updateManagerFieldDaySchema,
  listManagerFieldDaysQuerySchema,
  meQuerySchema
};
