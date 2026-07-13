const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const productService = require('../services/product.service');
const lookupService = require('../services/lookup.service');
const catalogSyncService = require('../services/catalogSync.service');
const productSearchService = require('../services/productSearch.service');

const lookup = asyncHandler(async (req, res) => {
  const data = await lookupService.products(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const search = asyncHandler(async (req, res) => {
  const data = await productSearchService.searchProducts(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const list = asyncHandler(async (req, res) => {
  const result = await productService.list(req.companyId, req.query, req.user, req.context.timeZone);
  return ApiResponse.paginated(res, result);
});

const create = asyncHandler(async (req, res) => {
  const data = await productService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data);
});

const getById = asyncHandler(async (req, res) => {
  const data = await productService.getById(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await productService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Product updated');
});

const remove = asyncHandler(async (req, res) => {
  await productService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Product deactivated');
});

const compare = asyncHandler(async (req, res) => {
  const ids = req.query.ids || req.body?.ids;
  const data = await productService.compare(req.companyId, ids, req.user);
  return ApiResponse.success(res, data);
});

const sync = asyncHandler(async (req, res) => {
  const data = await productService.sync(req.companyId, req.query, req.user);
  return ApiResponse.success(res, data);
});

const catalogSync = asyncHandler(async (req, res) => {
  const data = await catalogSyncService.catalogSync(req.companyId, req.query, req.user);
  return ApiResponse.success(res, data);
});

module.exports = { lookup, search, list, create, getById, update, remove, compare, sync, catalogSync };
