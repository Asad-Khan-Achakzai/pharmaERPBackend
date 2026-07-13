const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const catalogCampaignService = require('../services/catalogCampaign.service');

const list = asyncHandler(async (req, res) => {
  const result = await catalogCampaignService.list(req.companyId, req.query, req.context.timeZone);
  return ApiResponse.paginated(res, result);
});

const listActive = asyncHandler(async (req, res) => {
  const data = await catalogCampaignService.listActive(req.companyId);
  return ApiResponse.success(res, data);
});

const getById = asyncHandler(async (req, res) => {
  const data = await catalogCampaignService.getById(req.companyId, req.params.id);
  return ApiResponse.success(res, data);
});

const create = asyncHandler(async (req, res) => {
  const data = await catalogCampaignService.create(req.companyId, req.body, req.user);
  return ApiResponse.created(res, data);
});

const update = asyncHandler(async (req, res) => {
  const data = await catalogCampaignService.update(req.companyId, req.params.id, req.body, req.user);
  return ApiResponse.success(res, data, 'Campaign updated');
});

const remove = asyncHandler(async (req, res) => {
  await catalogCampaignService.remove(req.companyId, req.params.id, req.user);
  return ApiResponse.success(res, null, 'Campaign deleted');
});

module.exports = { list, listActive, getById, create, update, remove };
