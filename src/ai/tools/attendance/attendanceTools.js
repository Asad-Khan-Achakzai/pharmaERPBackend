const Joi = require('joi');
const { defineTool } = require('../baseTool');
const attendanceService = require('../../../services/attendance.service');
const { resolveSubtreeUserIds } = require('../../../utils/teamScope');
const { userHasPermission, userHasTenantWideAccess } = require('../../../utils/effectivePermissions');

const attendanceToday = defineTool({
  name: 'attendance_today',
  description: "Get today's attendance status for the user.",
  requiredPermissions: ['attendance.view'],
  parameters: Joi.object({}),
  async run(ctx) {
    const today = await attendanceService.getMeToday(ctx.companyId, ctx.userId, ctx.timeZone);
    return today;
  }
});

const attendanceHistory = defineTool({
  name: 'attendance_history',
  description: 'Get attendance report for a date range.',
  requiredPermissions: ['attendance.view'],
  parameters: Joi.object({
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
    employeeId: Joi.string().hex().length(24).optional()
  }),
  async run(ctx, params) {
    let visibleUserIds = null;
    if (params.employeeId) {
      visibleUserIds = [params.employeeId];
    } else if (!userHasTenantWideAccess(ctx.user) && !userHasPermission(ctx.user, 'attendance.viewCompany')) {
      if (userHasPermission(ctx.user, 'attendance.viewTeam')) {
        visibleUserIds = await resolveSubtreeUserIds(ctx.companyId, ctx.userId, {
          includeSelf: true,
          activeOnly: true
        });
      } else {
        visibleUserIds = [ctx.userId];
      }
    }

    const report = await attendanceService.report(
      ctx.companyId,
      {
        fromDate: params.fromDate,
        toDate: params.toDate,
        employeeId: params.employeeId,
        limit: 50
      },
      ctx.timeZone
    );

    return {
      fromDate: params.fromDate,
      toDate: params.toDate,
      ...(visibleUserIds ? { scopedToEmployees: visibleUserIds.map(String) } : {}),
      report
    };
  }
});

module.exports = { attendanceToday, attendanceHistory };
