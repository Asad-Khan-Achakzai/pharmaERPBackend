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

const yyyyMmDd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

const mrepCoverageDashboardQuerySchema = Joi.object({
  from: yyyyMmDd.required(),
  to: yyyyMmDd.required(),
  repId: Joi.string().hex().length(24),
  search: Joi.string().trim().max(120).allow(''),
  sort: Joi.string().valid('coverageAsc', 'coverageDesc', 'nameAsc').default('coverageAsc')
});

const mrepCoverageDashboardDoctorsQuerySchema = Joi.object({
  from: yyyyMmDd.required(),
  to: yyyyMmDd.required(),
  repId: Joi.string().hex().length(24),
  search: Joi.string().trim().max(120).allow(''),
  status: Joi.string().valid('VISITED', 'PLANNED', 'MISSED', 'NOT_PLANNED'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50)
});

const mrepCoverageDashboardNodesQuerySchema = Joi.object({
  from: yyyyMmDd.required(),
  to: yyyyMmDd.required(),
  parentTerritoryId: Joi.string().hex().length(24),
  repId: Joi.string().hex().length(24),
  search: Joi.string().trim().max(120).allow(''),
  sort: Joi.string().valid('coverageAsc', 'coverageDesc', 'nameAsc').default('coverageAsc')
});

module.exports = {
  mrepMonthlyOverviewQuerySchema,
  mrepDoctorCoverageQuerySchema,
  mrepTerritoryCoverageQuerySchema,
  mrepDeviationSummaryQuerySchema,
  mrepRankingsQuerySchema,
  mrepTrendsQuerySchema,
  mrepTerritoryCompareQuerySchema,
  mrepCoverageDashboardQuerySchema,
  mrepCoverageDashboardDoctorsQuerySchema,
  mrepCoverageDashboardNodesQuerySchema
};
