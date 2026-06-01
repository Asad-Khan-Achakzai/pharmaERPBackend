const voucherService = require('../services/voucher.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  ApiResponse.paginated(res, await voucherService.list(req.companyId, req.query, req.context.timeZone));
});

const getById = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await voucherService.getById(req.companyId, req.params.id));
});

const create = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await voucherService.createManual(req.companyId, req.body, req.user));
});

const fundTransfer = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await voucherService.createFundTransfer(req.companyId, req.body, req.user));
});

const reverse = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await voucherService.reverse(req.companyId, req.params.id, req.user), 'Voucher reversed');
});

module.exports = { list, getById, create, fundTransfer, reverse };
