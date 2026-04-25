const Joi = require('joi');

const createTargetSchema = Joi.object({
  medicalRepId: Joi.string().required(),
  month: Joi.string().required().pattern(/^\d{4}-\d{2}$/),
  salesTarget: Joi.number().min(0).default(0),
  packsTarget: Joi.number().integer().min(0).default(0)
}).custom((value, helpers) => {
  const sales = Number(value.salesTarget) || 0;
  const packs = Number(value.packsTarget) || 0;
  if (sales > 0 || packs > 0) return value;
  return helpers.error('any.custom', {
    message: 'At least one of sales target or packs target must be greater than 0'
  });
});

const updateTargetSchema = Joi.object({
  salesTarget: Joi.number().min(0),
  packsTarget: Joi.number().integer().min(0)
}).min(1);

const createWeeklyPlanSchema = Joi.object({
  medicalRepId: Joi.string(),
  weekStartDate: Joi.date().required(),
  weekEndDate: Joi.date().required(),
  notes: Joi.string().trim().allow(''),
  doctorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean().default(true), completed: Joi.boolean().default(false), notes: Joi.string().allow('') })),
  distributorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean().default(true), completed: Joi.boolean().default(false), notes: Joi.string().allow('') })),
  status: Joi.string().valid('DRAFT', 'ACTIVE', 'COMPLETED', 'SUBMITTED', 'REVIEWED')
});

const updateWeeklyPlanSchema = Joi.object({
  notes: Joi.string().trim().allow(''),
  medicalRepId: Joi.string(),
  weekStartDate: Joi.date(),
  weekEndDate: Joi.date(),
  doctorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean(), completed: Joi.boolean(), notes: Joi.string().allow('') })),
  distributorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean(), completed: Joi.boolean(), notes: Joi.string().allow('') })),
  status: Joi.string().valid('DRAFT', 'ACTIVE', 'COMPLETED', 'SUBMITTED', 'REVIEWED')
}).min(1);

module.exports = { createTargetSchema, updateTargetSchema, createWeeklyPlanSchema, updateWeeklyPlanSchema };
