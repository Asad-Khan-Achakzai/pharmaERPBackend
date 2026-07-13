const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const productKitService = require('../services/productKit.service');

const list = asyncHandler(async (req, res) => {
  const result = await productKitService.list(req.companyId, req.query, req.context.timeZone);
  return ApiResponse.paginated(res, result);
});

const lookup = asyncHandler(async (req, res) => {
  const data = await productKitService.lookup(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const getById = asyncHandler(async (req, res) => {
  const data = await productKitService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await productKitService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await productKitService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Kit updated');
});

const remove = asyncHandler(async (req, res) => {
  await productKitService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Kit deleted');
});

module.exports = { list, lookup, getById, create, update, remove };
