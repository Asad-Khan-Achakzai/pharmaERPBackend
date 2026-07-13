const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const brandService = require('../services/brand.service');

const list = asyncHandler(async (req, res) => {
  const result = await brandService.list(req.companyId, req.query, req.context.timeZone);
  return ApiResponse.paginated(res, result);
});

const lookup = asyncHandler(async (req, res) => {
  const data = await brandService.lookup(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const getById = asyncHandler(async (req, res) => {
  const data = await brandService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await brandService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await brandService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Brand updated');
});

const remove = asyncHandler(async (req, res) => {
  await brandService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Brand deactivated');
});

module.exports = { list, lookup, getById, create, update, remove };
