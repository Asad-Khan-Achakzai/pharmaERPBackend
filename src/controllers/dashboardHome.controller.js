const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const dashboardHomeService = require('../services/dashboardHome.service');
const teamSummaryService = require('../services/teamSummary.service');

const isNewDashboardEnabled = () => String(process.env.ENABLE_NEW_DASHBOARD || '').toLowerCase() === 'true';

/**
 * GET /dashboard/home — unified snapshot; feature-flagged (ENABLE_NEW_DASHBOARD).
 * Reuses existing services only; does not replace /reports/dashboard, /plan-items/today, etc.
 */
const home = asyncHandler(async (req, res) => {
  if (!isNewDashboardEnabled()) {
    throw new ApiError(404, 'Dashboard aggregation is not enabled');
  }
  const data = await dashboardHomeService.getHome(req.companyId, req.user, req.query, req.context.timeZone);
  ApiResponse.success(res, data);
});

/**
 * GET /dashboard/team-summary — manager rollup (Phase 2C). Always live (no env flag) and gated
 * via `team.view` permission so it's a no-op for individual reps.
 */
const teamSummary = asyncHandler(async (req, res) => {
  const data = await teamSummaryService.getTeamSummary(req.companyId, req.user, req.context.timeZone);
  ApiResponse.success(res, data);
});

module.exports = { home, teamSummary };
