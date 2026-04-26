const roleService = require('../services/role.service');
const User = require('../models/User');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await roleService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const role = await roleService.getById(req.companyId, req.params.id);
  const count = await User.countDocuments({ companyId: req.companyId, roleId: role._id });
  ApiResponse.success(res, { ...role.toObject(), userCount: count });
});

const create = asyncHandler(async (req, res) => {
  const role = await roleService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, role);
});

const update = asyncHandler(async (req, res) => {
  const role = await roleService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, role, 'Role updated');
});

const remove = asyncHandler(async (req, res) => {
  await roleService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, { success: true }, 'Role deleted successfully');
});

module.exports = { list, getById, create, update, remove };
