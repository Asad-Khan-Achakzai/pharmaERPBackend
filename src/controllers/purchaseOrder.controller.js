const purchaseOrderService = require('../services/purchaseOrder.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await purchaseOrderService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const data = await purchaseOrderService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await purchaseOrderService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Purchase order created');
});

const update = asyncHandler(async (req, res) => {
  const data = await purchaseOrderService.updateById(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Purchase order updated');
});

const approve = asyncHandler(async (req, res) => {
  const data = await purchaseOrderService.approve(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Purchase order approved');
});

module.exports = { list, getById, create, update, approve };
