const notificationAnalyticsService = require('../services/notificationAnalytics.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const health = asyncHandler(async (req, res) => {
  const data = await notificationAnalyticsService.companyHealth(req.companyId, req.query);
  ApiResponse.paginated(res, data);
});

const rollup = asyncHandler(async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const data = await notificationAnalyticsService.rollupRecent(req.companyId, days);
  ApiResponse.success(res, data, 'Rollup complete');
});

module.exports = { health, rollup };
