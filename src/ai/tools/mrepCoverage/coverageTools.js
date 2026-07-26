const Joi = require('joi');
const { defineTool } = require('../baseTool');
const mrepReportService = require('../../../services/mrepReport.service');
const { DateTime } = require('luxon');

const coverageAnalysis = defineTool({
  name: 'coverage_analysis',
  description: 'Analyze doctor visit coverage and KPIs for a rep or team for a month.',
  requiredPermissions: ['reports.view', 'team.view'],
  parameters: Joi.object({
    yyyyMm: Joi.string().pattern(/^\d{4}-\d{2}$/).optional(),
    repId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const yyyyMm =
      params.yyyyMm || DateTime.now().setZone(ctx.timeZone).toFormat('yyyy-MM');
    const overview = await mrepReportService.monthlyOverview(
      ctx.companyId,
      ctx.user,
      yyyyMm,
      ctx.timeZone,
      { repId: params.repId }
    );
    return { month: yyyyMm, overview };
  }
});

const territoryAnalysis = defineTool({
  name: 'territory_analysis',
  description: 'Get territory coverage comparison for managers.',
  requiredPermissions: ['territories.view', 'reports.view'],
  parameters: Joi.object({
    parentTerritoryId: Joi.string().hex().length(24).optional(),
    yyyyMm: Joi.string().pattern(/^\d{4}-\d{2}$/).optional()
  }),
  async run(ctx, params) {
    const yyyyMm =
      params.yyyyMm || DateTime.now().setZone(ctx.timeZone).toFormat('yyyy-MM');
    if (!params.parentTerritoryId) {
      const rankings = await mrepReportService.rankings(
        ctx.companyId,
        ctx.user,
        yyyyMm,
        ctx.timeZone,
        {}
      );
      return { month: yyyyMm, rankings };
    }
    return mrepReportService.territoryCompare(
      ctx.companyId,
      params.parentTerritoryId,
      yyyyMm,
      ctx.timeZone,
      ctx.userId,
      ctx.permissions
    );
  }
});

module.exports = { coverageAnalysis, territoryAnalysis };
