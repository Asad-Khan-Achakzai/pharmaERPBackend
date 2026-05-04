const visitLogService = require('../services/visitLog.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const unplanned = asyncHandler(async (req, res) => {
  const data = await visitLogService.createUnplanned(req.companyId, req.body, req.user, req.context.timeZone);
  ApiResponse.created(res, data, 'Unplanned visit logged');
});

module.exports = { unplanned };
