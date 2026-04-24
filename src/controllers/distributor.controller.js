const distributorService = require('../services/distributor.service');
const lookupService = require('../services/lookup.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const lookup = asyncHandler(async (req, res) => {
  const data = await lookupService.distributors(req.companyId, req.query);
  ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  const result = await distributorService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const dist = await distributorService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, dist);
});

const getById = asyncHandler(async (req, res) => {
  const dist = await distributorService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, dist);
});

const update = asyncHandler(async (req, res) => {
  const dist = await distributorService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, dist, 'Distributor updated');
});

const remove = asyncHandler(async (req, res) => {
  await distributorService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Distributor deactivated');
});

module.exports = { lookup, list, create, getById, update, remove };
