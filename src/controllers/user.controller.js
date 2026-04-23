const userService = require('../services/user.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await userService.list(req.companyId, req.query);
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

const remove = asyncHandler(async (req, res) => {
  await userService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'User deactivated');
});

module.exports = { list, create, getById, update, remove };
