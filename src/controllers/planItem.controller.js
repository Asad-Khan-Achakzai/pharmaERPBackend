const planItemService = require('../services/planItem.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');

const listToday = asyncHandler(async (req, res) => {
  let targetId = req.query.employeeId || req.user.userId;
  if (String(targetId) !== String(req.user.userId)) {
    if (!userHasPermission(req.user, 'admin.access')) {
      throw new ApiError(403, 'Only administrators can view another employee\'s plan items');
    }
  }
  const data = await planItemService.listTodayPending(req.companyId, targetId, req.query.date);
  ApiResponse.success(res, data);
});

const markVisit = asyncHandler(async (req, res) => {
  const data = await planItemService.markVisit(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Visit recorded');
});

const update = asyncHandler(async (req, res) => {
  const data = await planItemService.updateByAdmin(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Plan item updated');
});

module.exports = { listToday, markVisit, update };
