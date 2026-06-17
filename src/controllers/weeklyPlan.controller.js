const weeklyPlanService = require('../services/weeklyPlan.service');
const planItemService = require('../services/planItem.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission, userHasTenantWideAccess } = require('../utils/effectivePermissions');
const {
  resolveOrderVisibleMedicalRepIds,
  narrowMedicalRepScopeForQuery
} = require('../utils/orderScope.util');

const resolveWeeklyPlanVisibility = async (req) => {
  const rawScope = req.query?.scope;
  if (
    rawScope === 'team' &&
    !userHasTenantWideAccess(req.user) &&
    !userHasPermission(req.user, 'team.viewAllReports')
  ) {
    throw new ApiError(403, 'scope=team requires team.viewAllReports permission');
  }
  let visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  visibleRepIds = narrowMedicalRepScopeForQuery(visibleRepIds, rawScope, req.user.userId);
  return visibleRepIds;
};

const list = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveWeeklyPlanVisibility(req);
  ApiResponse.paginated(
    res,
    await weeklyPlanService.list(req.companyId, req.query, req.context.timeZone, { visibleRepIds })
  );
});
const create = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  ApiResponse.created(
    res,
    await weeklyPlanService.create(req.companyId, req.body, req.user, { visibleRepIds })
  );
});
const update = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  ApiResponse.success(
    res,
    await weeklyPlanService.update(req.companyId, req.params.id, req.body, req.user, req.context.timeZone, {
      visibleRepIds
    }),
    'Plan updated'
  );
});
const getByRep = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  ApiResponse.success(res, await weeklyPlanService.getByRep(req.companyId, req.params.id, { visibleRepIds }));
});
const getById = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  ApiResponse.success(
    res,
    await weeklyPlanService.getById(req.companyId, req.params.id, req.context.timeZone, { visibleRepIds })
  );
});
const copyPreviousWeek = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  const data = await weeklyPlanService.copyPreviousWeekIntoPlan(
    req.companyId,
    req.params.id,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  ApiResponse.success(res, data, 'Previous week copied');
});
const bulkPlanItems = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  const data = await planItemService.bulkCreateForPlan(
    req.companyId,
    req.params.id,
    req.body.items,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  ApiResponse.created(res, data, 'Plan items added');
});

const submit = asyncHandler(async (req, res) => {
  const data = await weeklyPlanService.submit(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Plan submitted for approval');
});

const approve = asyncHandler(async (req, res) => {
  const data = await weeklyPlanService.approve(req.companyId, req.params.id, req.user);
  ApiResponse.success(res, data, 'Plan approved');
});

const reject = asyncHandler(async (req, res) => {
  const data = await weeklyPlanService.reject(req.companyId, req.params.id, req.body, req.user);
  ApiResponse.success(res, data, 'Plan rejected');
});

const pendingApprovals = asyncHandler(async (req, res) => {
  const data = await weeklyPlanService.pendingApprovals(req.companyId, req.user);
  ApiResponse.success(res, data, 'Pending approvals');
});

const optimizeRoute = asyncHandler(async (req, res) => {
  const visibleRepIds = await resolveOrderVisibleMedicalRepIds(req.companyId, req.user);
  const data = await weeklyPlanService.optimizeRoute(
    req.companyId,
    req.params.id,
    req.body,
    req.user,
    req.context.timeZone,
    { visibleRepIds }
  );
  ApiResponse.success(res, data, 'Route optimized');
});

module.exports = {
  list,
  create,
  update,
  getByRep,
  getById,
  copyPreviousWeek,
  bulkPlanItems,
  submit,
  approve,
  reject,
  pendingApprovals,
  optimizeRoute
};
