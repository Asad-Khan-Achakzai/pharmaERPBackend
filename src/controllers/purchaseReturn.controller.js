const purchaseReturnService = require('../services/purchaseReturn.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const returnableForGrn = asyncHandler(async (req, res) => {
  const data = await purchaseReturnService.getReturnableCaps(req.companyId, req.params.grnId);
  ApiResponse.success(res, data);
});

const list = asyncHandler(async (req, res) => {
  const result = await purchaseReturnService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const data = await purchaseReturnService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await purchaseReturnService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Purchase return created');
});

const update = asyncHandler(async (req, res) => {
  const data = await purchaseReturnService.updateById(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Purchase return updated');
});

const post = asyncHandler(async (req, res) => {
  const data = await purchaseReturnService.post(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Purchase return posted');
});

module.exports = { returnableForGrn, list, getById, create, update, post };
