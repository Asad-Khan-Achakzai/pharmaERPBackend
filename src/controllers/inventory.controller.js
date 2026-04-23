const inventoryService = require('../services/inventory.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const getAll = asyncHandler(async (req, res) => {
  const result = await inventoryService.getAll(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getByDistributor = asyncHandler(async (req, res) => {
  const inventory = await inventoryService.getByDistributor(req.companyId, req.params.id);
  ApiResponse.success(res, inventory);
});

const transfer = asyncHandler(async (req, res) => {
  const result = await inventoryService.transfer(req.companyId, req.body, req.user);
  ApiResponse.created(res, result, 'Stock transferred successfully');
});

const getTransfers = asyncHandler(async (req, res) => {
  const result = await inventoryService.getTransfers(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getSummary = asyncHandler(async (req, res) => {
  const result = await inventoryService.getSummary(req.companyId);
  ApiResponse.success(res, result);
});

module.exports = { getAll, getByDistributor, transfer, getTransfers, getSummary };
