const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const productEngagementService = require('../services/productEngagement.service');

const ingest = asyncHandler(async (req, res) => {
  const data = await productEngagementService.ingestBatch(
    req.companyId,
    req.user.userId,
    req.body.events || []
  );
  return ApiResponse.created(res, data, 'Events accepted');
});

module.exports = { ingest };
