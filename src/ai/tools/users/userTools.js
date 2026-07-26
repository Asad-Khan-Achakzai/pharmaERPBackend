const Joi = require('joi');
const { defineTool } = require('../baseTool');
const User = require('../../../models/User');
const mrepReportService = require('../../../services/mrepReport.service');
const { resolveSubtreeUserIds } = require('../../../utils/teamScope');
const { userHasTenantWideAccess, userHasPermission } = require('../../../utils/effectivePermissions');
const { DateTime } = require('luxon');

const employeeSummary = defineTool({
  name: 'employee_summary',
  description:
    'Count employees/users in the company. Returns total active users and breakdown by role (admin, medical rep, etc.).',
  requiredPermissions: ['users.view', 'admin.access', 'team.view'],
  parameters: Joi.object({
    activeOnly: Joi.boolean().default(true)
  }),
  async run(ctx, params) {
    if (!userHasTenantWideAccess(ctx.user) && !userHasPermission(ctx.user, 'users.view')) {
      const teamIds = await resolveSubtreeUserIds(ctx.companyId, ctx.userId, {
        includeSelf: true,
        activeOnly: true
      });
      return {
        scope: 'team',
        total: teamIds.length,
        message: 'Scoped to your reporting team. Use admin access for company-wide headcount.'
      };
    }

    const filter = { companyId: ctx.companyId, isDeleted: { $ne: true } };
    if (params.activeOnly) filter.isActive = true;

    const [total, byRole] = await Promise.all([
      User.countDocuments(filter),
      User.aggregate([
        { $match: filter },
        { $group: { _id: '$role', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    return {
      scope: 'company',
      total,
      activeOnly: params.activeOnly,
      byRole: byRole.map((r) => ({ role: r._id || 'UNKNOWN', count: r.count }))
    };
  }
});

const userProfile = defineTool({
  name: 'user_profile',
  description: 'Get profile summary for a user (self or team member if permitted).',
  requiredPermissions: ['users.view'],
  parameters: Joi.object({
    userId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    const targetId = params.userId || String(ctx.userId);
    if (String(targetId) !== String(ctx.userId)) {
      if (!userHasTenantWideAccess(ctx.user) && !userHasPermission(ctx.user, 'team.view')) {
        const team = await resolveSubtreeUserIds(ctx.companyId, ctx.userId, { includeSelf: true });
        if (!team.some((id) => String(id) === String(targetId))) {
          throw new Error('User not accessible.');
        }
      }
    }
    const user = await User.findOne({ _id: targetId, companyId: ctx.companyId, isDeleted: { $ne: true } })
      .select('name email role phone territoryId managerId isActive')
      .populate('territoryId', 'name code')
      .populate('managerId', 'name')
      .lean();
    if (!user) throw new Error('User not found.');
    return user;
  }
});

const teamPerformance = defineTool({
  name: 'team_performance',
  description: 'Get team KPI overview and rankings for the current or specified month.',
  requiredPermissions: ['team.view', 'reports.view'],
  parameters: Joi.object({
    yyyyMm: Joi.string().pattern(/^\d{4}-\d{2}$/).optional()
  }),
  async run(ctx, params) {
    const yyyyMm =
      params.yyyyMm || DateTime.now().setZone(ctx.timeZone).toFormat('yyyy-MM');
    const overview = await mrepReportService.monthlyOverview(
      ctx.companyId,
      ctx.user,
      yyyyMm,
      ctx.timeZone,
      {}
    );
    const rankings = await mrepReportService.rankings(
      ctx.companyId,
      ctx.user,
      yyyyMm,
      ctx.timeZone,
      {}
    );
    return { month: yyyyMm, overview, rankings };
  }
});

module.exports = { userProfile, teamPerformance, employeeSummary };
