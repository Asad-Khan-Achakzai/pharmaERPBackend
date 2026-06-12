const Joi = require('joi');

const productPacksTargetItemSchema = Joi.object({
  productId: Joi.string().required(),
  packsTarget: Joi.number().integer().min(1).required()
});

const hasAnyTarget = (value) => {
  const sales = Number(value.salesTarget) || 0;
  const packs = Number(value.packsTarget) || 0;
  const productSum = Array.isArray(value.productPacksTargets)
    ? value.productPacksTargets.reduce((sum, row) => sum + (Number(row?.packsTarget) || 0), 0)
    : 0;
  return sales > 0 || packs > 0 || productSum > 0;
};

const createTargetSchema = Joi.object({
  medicalRepId: Joi.string().required(),
  month: Joi.string().required().pattern(/^\d{4}-\d{2}$/),
  salesTarget: Joi.number().min(0).default(0),
  packsTarget: Joi.number().integer().min(0).default(0),
  productPacksTargets: Joi.array().items(productPacksTargetItemSchema).default([])
}).custom((value, helpers) => {
  if (hasAnyTarget(value)) return value;
  return helpers.error('any.custom', {
    message: 'At least one of sales target, whole packs target, or product pack targets must be greater than 0'
  });
});

const updateTargetSchema = Joi.object({
  salesTarget: Joi.number().min(0),
  packsTarget: Joi.number().integer().min(0),
  productPacksTargets: Joi.array().items(productPacksTargetItemSchema)
})
  .min(1)
  .custom((value, helpers) => {
    if (value.productPacksTargets !== undefined && !Array.isArray(value.productPacksTargets)) {
      return helpers.error('any.custom', { message: 'productPacksTargets must be an array' });
    }
    return value;
  });

const packsBreakdownQuerySchema = Joi.object({
  medicalRepId: Joi.string().required(),
  month: Joi.string().required().pattern(/^\d{4}-\d{2}$/)
});

const createWeeklyPlanSchema = Joi.object({
  medicalRepId: Joi.string(),
  weekStartDate: Joi.date().required(),
  weekEndDate: Joi.date().required(),
  notes: Joi.string().trim().allow(''),
  doctorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean().default(true), completed: Joi.boolean().default(false), notes: Joi.string().allow('') })),
  distributorVisits: Joi.array().items(Joi.object({ entityId: Joi.string().required(), planned: Joi.boolean().default(true), completed: Joi.boolean().default(false), notes: Joi.string().allow('') })),
  status: Joi.string().valid('DRAFT', 'ACTIVE', 'COMPLETED', 'SUBMITTED', 'REVIEWED'),
  /** Phase 2B — explicit override; otherwise inherited from Company.weeklyPlanApprovalRequired. */
  approvalRequired: Joi.boolean()
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

module.exports = {
  createTargetSchema,
  updateTargetSchema,
  packsBreakdownQuerySchema,
  createWeeklyPlanSchema,
  updateWeeklyPlanSchema
};
