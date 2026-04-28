const goodsReceiptService = require('../services/goodsReceipt.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await goodsReceiptService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const data = await goodsReceiptService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await goodsReceiptService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Goods receipt created');
});

const update = asyncHandler(async (req, res) => {
  const data = await goodsReceiptService.updateById(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Goods receipt updated');
});

const post = asyncHandler(async (req, res) => {
  const data = await goodsReceiptService.post(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Goods receipt posted');
});

module.exports = { list, getById, create, update, post };
