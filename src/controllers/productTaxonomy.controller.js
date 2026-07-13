const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const productTaxonomyService = require('../services/productTaxonomy.service');

const list = asyncHandler(async (req, res) => {
  const result = await productTaxonomyService.list(req.companyId, req.query);
  return ApiResponse.paginated(res, result);
});

const tree = asyncHandler(async (req, res) => {
  const data = await productTaxonomyService.tree(req.companyId);
  return ApiResponse.success(res, data);
});

const lookup = asyncHandler(async (req, res) => {
  const data = await productTaxonomyService.lookup(req.companyId, req.query);
  return ApiResponse.success(res, data, 'OK');
});

const getById = asyncHandler(async (req, res) => {
  const data = await productTaxonomyService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await productTaxonomyService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await productTaxonomyService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Taxonomy node updated');
});

const remove = asyncHandler(async (req, res) => {
  await productTaxonomyService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Taxonomy node deleted');
});

module.exports = { list, tree, lookup, getById, create, update, remove };
