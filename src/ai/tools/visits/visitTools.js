const Joi = require('joi');
const { defineTool } = require('../baseTool');
const planItemService = require('../../../services/planItem.service');
const businessTime = require('../../../utils/businessTime');

function todayYmd(timeZone) {
  return businessTime.nowInBusinessTime(timeZone).toFormat('yyyy-MM-dd');
}
const { resolveSubtreeUserIds } = require('../../../utils/teamScope');
const { userHasTenantWideAccess, userHasPermission } = require('../../../utils/effectivePermissions');
const { PLAN_ITEM_STATUS } = require('../../../constants/enums');

async function resolveEmployeeScope(ctx) {
  if (userHasTenantWideAccess(ctx.user)) return null;
  if (userHasPermission(ctx.user, 'team.viewAllReports') || userHasPermission(ctx.user, 'team.view')) {
    return resolveSubtreeUserIds(ctx.companyId, ctx.userId, { includeSelf: true, activeOnly: true });
  }
  return [ctx.userId];
}

const todayVisits = defineTool({
  name: 'today_visits',
  description: "Get today's planned visits and execution status for the user or their team.",
  requiredPermissions: ['weeklyPlans.view'],
  parameters: Joi.object({
    employeeId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const ymd = todayYmd(ctx.timeZone);
    const employeeId = params.employeeId || String(ctx.userId);
    const execution = await planItemService.buildTodayExecution(
      ctx.companyId,
      employeeId,
      ymd,
      ctx.timeZone
    );
    return {
      date: ymd,
      employeeId,
      summary: execution.summary || execution,
      items: (execution.items || execution.planItems || []).slice(0, 30)
    };
  }
});

const pendingVisits = defineTool({
  name: 'pending_visits',
  description: 'List pending (not yet visited) plan items for today.',
  requiredPermissions: ['weeklyPlans.view'],
  parameters: Joi.object({
    employeeId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const ymd = todayYmd(ctx.timeZone);
    const employeeId = params.employeeId || String(ctx.userId);
    const pending = await planItemService.listTodayPending(ctx.companyId, employeeId, ymd, ctx.timeZone);
    return { date: ymd, count: pending.length, pending: pending.slice(0, 30) };
  }
});

const missedVisits = defineTool({
  name: 'missed_visits',
  description: 'Get missed visits for a date range (defaults to current month).',
  requiredPermissions: ['weeklyPlans.view'],
  parameters: Joi.object({
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    employeeId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const ymd = todayYmd(ctx.timeZone);
    const employeeId = params.employeeId || String(ctx.userId);
    const execution = await planItemService.buildTodayExecution(
      ctx.companyId,
      employeeId,
      ymd,
      ctx.timeZone
    );
    const items = execution.items || execution.planItems || [];
    const missed = items.filter((i) => i.status === PLAN_ITEM_STATUS.MISSED || i.status === 'MISSED');
    return { date: ymd, missedCount: missed.length, missed: missed.slice(0, 30) };
  }
});

const teamVisitsToday = defineTool({
  name: 'team_visits_today',
  description: 'For managers: team visit execution summary for today.',
  requiredPermissions: ['team.view', 'weeklyPlans.view'],
  parameters: Joi.object({}),
  async run(ctx) {
    const ymd = todayYmd(ctx.timeZone);
    const teamIds = await resolveEmployeeScope(ctx);
    if (!teamIds?.length) return { date: ymd, team: [] };
    const team = await planItemService.buildTeamVisits(ctx.companyId, teamIds, ymd, ctx.timeZone);
    return { date: ymd, team: team.slice(0, 50) };
  }
});

module.exports = { todayVisits, pendingVisits, missedVisits, teamVisitsToday };
