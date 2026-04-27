const platformService = require('../services/platform.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const dashboard = asyncHandler(async (req, res) => {
  const data = await platformService.getForRequestUser(req.user.userId, req.query);
  ApiResponse.success(res, data, 'OK');
});

module.exports = { dashboard };
