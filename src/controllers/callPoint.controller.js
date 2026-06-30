const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const callPointService = require('../services/callPoint.service');

const list = asyncHandler(async (req, res) => {
  const result = await callPointService.list(req.companyId, req.query, req.context.timeZone);
  return ApiResponse.paginated(res, result);
});

const lookup = asyncHandler(async (req, res) => {
  const data = await callPointService.lookup(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const getById = asyncHandler(async (req, res) => {
  const data = await callPointService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await callPointService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data, 'CP created');
});

const update = asyncHandler(async (req, res) => {
  const data = await callPointService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'CP updated');
});

const remove = asyncHandler(async (req, res) => {
  const data = await callPointService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, data, 'CP deleted');
});

module.exports = { list, lookup, getById, create, update, remove };
