const doctorLocationSuggestionService = require('../services/doctorLocationSuggestion.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const data = await doctorLocationSuggestionService.list(req.companyId, req.user, req.query);
  ApiResponse.paginated(res, data);
});

const approve = asyncHandler(async (req, res) => {
  const data = await doctorLocationSuggestionService.approve(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Doctor location approved');
});

const reject = asyncHandler(async (req, res) => {
  const data = await doctorLocationSuggestionService.reject(
    req.companyId,
    req.params.id,
    req.body,
    req.user
  );
  ApiResponse.success(res, data, 'Doctor location suggestion rejected');
});

module.exports = { list, approve, reject };
