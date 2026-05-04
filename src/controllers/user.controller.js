const userService = require('../services/user.service');
const lookupService = require('../services/lookup.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const assignable = asyncHandler(async (req, res) => {
  const data = await lookupService.assignableUsers(req.companyId, req.query);
  ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  const result = await userService.list(req.companyId, req.query, req.context.timeZone);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const user = await userService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, user);
});

const getById = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, user);
});

const update = asyncHandler(async (req, res) => {
  const user = await userService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, user, 'User updated');
});

const setStatus = asyncHandler(async (req, res) => {
  const user = await userService.setStatus(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, user, user.isActive ? 'User activated successfully' : 'User deactivated successfully');
});

module.exports = { assignable, list, create, getById, update, setStatus };
