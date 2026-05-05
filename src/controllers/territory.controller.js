const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const territoryService = require('../services/territory.service');

const list = asyncHandler(async (req, res) => {
  const result = await territoryService.list(req.companyId, req.query);
  return ApiResponse.paginated(res, result);
});

const tree = asyncHandler(async (req, res) => {
  const data = await territoryService.tree(req.companyId);
  return ApiResponse.success(res, data, 'Territory tree');
});

const lookup = asyncHandler(async (req, res) => {
  const data = await territoryService.lookup(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const getById = asyncHandler(async (req, res) => {
  const data = await territoryService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await territoryService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data, 'Territory created');
});

const update = asyncHandler(async (req, res) => {
  const data = await territoryService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Territory updated');
});

const remove = asyncHandler(async (req, res) => {
  const data = await territoryService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, data, 'Territory deleted');
});

module.exports = { list, tree, lookup, getById, create, update, remove };
