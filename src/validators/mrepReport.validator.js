const Joi = require('joi');

const yyyyMm = Joi.string().pattern(/^\d{4}-\d{2}$/);

const mrepMonthlyOverviewQuerySchema = Joi.object({
  month: yyyyMm,
  repId: Joi.string().hex().length(24)
});

const mrepDoctorCoverageQuerySchema = Joi.object({
  month: yyyyMm.required(),
  repId: Joi.string().hex().length(24).required()
});

const mrepTerritoryCoverageQuerySchema = Joi.object({
  month: yyyyMm.required(),
  territoryId: Joi.string().hex().length(24).required()
});

const mrepDeviationSummaryQuerySchema = Joi.object({
  month: yyyyMm.required(),
  repId: Joi.string().hex().length(24)
});

const mrepRankingsQuerySchema = Joi.object({
  month: yyyyMm.required(),
  repId: Joi.string().hex().length(24)
});

const mrepTrendsQuerySchema = Joi.object({
  months: Joi.number().integer().min(1).max(24).default(6),
  repId: Joi.string().hex().length(24)
});

const mrepTerritoryCompareQuerySchema = Joi.object({
  month: yyyyMm.required(),
  parentTerritoryId: Joi.string().hex().length(24).required()
});

module.exports = {
  mrepMonthlyOverviewQuerySchema,
  mrepDoctorCoverageQuerySchema,
  mrepTerritoryCoverageQuerySchema,
  mrepDeviationSummaryQuerySchema,
  mrepRankingsQuerySchema,
  mrepTrendsQuerySchema,
  mrepTerritoryCompareQuerySchema
};
