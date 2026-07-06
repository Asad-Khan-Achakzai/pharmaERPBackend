const logger = require('../utils/logger');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

/** Accept mobile tracking diagnostics — logged for support; no DB persistence in v1 stub. */
const ingest = asyncHandler(async (req, res) => {
  logger.info('tracking_metrics', {
    companyId: req.companyId,
    userId: req.user.userId,
    metrics: req.body.metrics || {}
  });
  ApiResponse.success(res, { accepted: true });
});

module.exports = { ingest };
