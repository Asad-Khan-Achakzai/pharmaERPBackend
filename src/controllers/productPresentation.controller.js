const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const productPresentationService = require('../services/productPresentation.service');

const listForProduct = asyncHandler(async (req, res) => {
  const data = await productPresentationService.listForProduct(req.companyId, req.params.productId);
  return ApiResponse.success(res, data);
});

const getDefault = asyncHandler(async (req, res) => {
  const data = await productPresentationService.getDefaultForProduct(
    req.companyId,
    req.params.productId
  );
  return ApiResponse.success(res, data);
});

const getById = asyncHandler(async (req, res) => {
  const data = await productPresentationService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await productPresentationService.create(
    req.companyId,
    req.params.productId,
    req.body,
    req.user
  );
  return ApiResponse.created(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await productPresentationService.update(
    req.companyId,
    req.params.id,
    req.body,
    req.user
  );
  return ApiResponse.success(res, data, 'Presentation updated');
});

const publish = asyncHandler(async (req, res) => {
  const data = await productPresentationService.publish(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, data, 'Presentation published');
});

const quality = asyncHandler(async (req, res) => {
  const data = await productPresentationService.qualityCheck(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const remove = asyncHandler(async (req, res) => {
  await productPresentationService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Presentation deleted');
});

module.exports = { listForProduct, getDefault, getById, create, update, publish, quality, remove };
