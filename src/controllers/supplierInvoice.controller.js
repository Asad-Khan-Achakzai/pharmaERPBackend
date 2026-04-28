const supplierInvoiceService = require('../services/supplierInvoice.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await supplierInvoiceService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const data = await supplierInvoiceService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await supplierInvoiceService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, data, 'Supplier invoice created');
});

const update = asyncHandler(async (req, res) => {
  const data = await supplierInvoiceService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Supplier invoice updated');
});

const post = asyncHandler(async (req, res) => {
  const data = await supplierInvoiceService.postInvoice(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Supplier invoice posted');
});

module.exports = { list, getById, create, update, post };
