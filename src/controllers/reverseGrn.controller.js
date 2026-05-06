const reverseGrnService = require('../services/reverseGrn.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const reversePosted = asyncHandler(async (req, res) => {
  const data = await reverseGrnService.reversePostedGrn(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Goods receipt reversed');
});

module.exports = { reversePosted };
