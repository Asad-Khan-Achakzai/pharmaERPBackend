const targetService = require('../services/target.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => { ApiResponse.paginated(res, await targetService.list(req.companyId, req.query)); });
const create = asyncHandler(async (req, res) => { ApiResponse.created(res, await targetService.create(req.companyId, req.body, req.user)); });
const update = asyncHandler(async (req, res) => { ApiResponse.success(res, await targetService.update(req.companyId, req.params.id, req.body, req.user), 'Target updated'); });
const remove = asyncHandler(async (req, res) => {
  await targetService.remove(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, null, 'Target deleted');
});
const getByRep = asyncHandler(async (req, res) => { ApiResponse.success(res, await targetService.getByRep(req.companyId, req.params.id)); });

module.exports = { list, create, update, remove, getByRep };
