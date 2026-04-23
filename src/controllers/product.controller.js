const productService = require('../services/product.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const result = await productService.list(req.companyId, req.query);
  ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const product = await productService.create(req.companyId, req.body, req.user);
  ApiResponse.created(res, product);
});

const getById = asyncHandler(async (req, res) => {
  const product = await productService.getById(req.companyId, req.params.id);
  ApiResponse.success(res, product);
});

const update = asyncHandler(async (req, res) => {
  const product = await productService.update(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, product, 'Product updated');
});

const remove = asyncHandler(async (req, res) => {
  await productService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Product deactivated');
});

module.exports = { list, create, getById, update, remove };
