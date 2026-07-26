const Joi = require('joi');
const { defineTool } = require('../baseTool');
const reportService = require('../../../services/report.service');
const businessTime = require('../../../utils/businessTime');

function todayYmd(timeZone) {
  return businessTime.nowInBusinessTime(timeZone).toFormat('yyyy-MM-dd');
}
const { DateTime } = require('luxon');

function monthRange(timeZone, monthsBack = 0) {
  const dt = DateTime.now().setZone(timeZone).minus({ months: monthsBack });
  const start = dt.startOf('month').toISODate();
  const end = dt.endOf('month').toISODate();
  return { start, end, yyyyMm: dt.toFormat('yyyy-MM') };
}

const salesSummary = defineTool({
  name: 'sales_summary',
  description: 'Get sales dashboard summary for a date range or current month.',
  requiredPermissions: ['reports.view'],
  parameters: Joi.object({
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    medicalRepId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const range = params.fromDate && params.toDate
      ? { startDate: params.fromDate, endDate: params.toDate }
      : (() => {
          const m = monthRange(ctx.timeZone);
          return { startDate: m.start, endDate: m.end };
        })();

    const data = await reportService.dashboard(ctx.companyId, {
      startDate: range.startDate,
      endDate: range.endDate,
      timeZone: ctx.timeZone,
      restrictToRepId: params.medicalRepId || (ctx.user?.role === 'MEDICAL_REP' ? String(ctx.userId) : undefined)
    });
    return data;
  }
});

const salesTrend = defineTool({
  name: 'sales_trend',
  description: 'Compare sales across recent months to identify trends.',
  requiredPermissions: ['reports.view'],
  parameters: Joi.object({
    months: Joi.number().integer().min(2).max(6).default(3)
  }),
  async run(ctx, params) {
    const trends = [];
    for (let i = 0; i < params.months; i++) {
      const m = monthRange(ctx.timeZone, i);
      const data = await reportService.dashboard(ctx.companyId, {
        startDate: m.start,
        endDate: m.end,
        timeZone: ctx.timeZone
      });
      trends.push({ month: m.yyyyMm, summary: data });
    }
    return { trends: trends.reverse() };
  }
});

module.exports = { salesSummary, salesTrend };
