const weeklyPlanService = require('../services/weeklyPlan.service');
const planItemService = require('../services/planItem.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const list = asyncHandler(async (req, res) => { ApiResponse.paginated(res, await weeklyPlanService.list(req.companyId, req.query)); });
const create = asyncHandler(async (req, res) => { ApiResponse.created(res, await weeklyPlanService.create(req.companyId, req.body, req.user)); });
const update = asyncHandler(async (req, res) => { ApiResponse.success(res, await weeklyPlanService.update(req.companyId, req.params.id, req.body, req.user), 'Plan updated'); });
const getByRep = asyncHandler(async (req, res) => { ApiResponse.success(res, await weeklyPlanService.getByRep(req.companyId, req.params.id)); });
const getById = asyncHandler(async (req, res) => { ApiResponse.success(res, await weeklyPlanService.getById(req.companyId, req.params.id)); });
const bulkPlanItems = asyncHandler(async (req, res) => {
  const data = await planItemService.bulkCreateForPlan(req.companyId, req.params.id, req.body.items, req.user);
  ApiResponse.created(res, data, 'Plan items added');
});

module.exports = { list, create, update, getByRep, getById, bulkPlanItems };
