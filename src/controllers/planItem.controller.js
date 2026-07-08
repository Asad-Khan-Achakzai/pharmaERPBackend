const planItemService = require('../services/planItem.service');
const coVisitAvailabilityService = require('../services/coVisitAvailability.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');

const assertEmployeeVisible = (visibleEmployeeIds, targetId) => {
  if (visibleEmployeeIds === null) return;
  const ok = visibleEmployeeIds.some((id) => String(id) === String(targetId));
  if (!ok) {
    throw new ApiError(403, 'You can only view plan items for yourself or your team');
  }
};

const resolveVisibleEmployeeIdsForVisits = async (req) => {
  if (userHasPermission(req.user, 'admin.access')) {
    return null;
  }
  if (userHasPermission(req.user, 'team.viewAllReports') || userHasPermission(req.user, 'team.view')) {
    return resolveSubtreeUserIds(req.companyId, req.user.userId, {
      includeSelf: true,
      activeOnly: true
    });
  }
  return [req.user.userId];
};

const listToday = asyncHandler(async (req, res) => {
  let targetId = req.query.employeeId || req.user.userId;
  if (String(targetId) !== String(req.user.userId)) {
    if (userHasPermission(req.user, 'admin.access')) {
      /* ok */
    } else if (
      userHasPermission(req.user, 'team.viewAllReports') ||
      userHasPermission(req.user, 'team.view')
    ) {
      const subtree = await resolveSubtreeUserIds(req.companyId, req.user.userId, {
        includeSelf: true,
        activeOnly: true
      });
      assertEmployeeVisible(subtree, targetId);
    } else {
      throw new ApiError(403, 'Only administrators can view another employee\'s plan items');
    }
  }
  const data = await planItemService.buildTodayExecution(
    req.companyId,
    targetId,
    req.query.date,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

const listTeamVisits = asyncHandler(async (req, res) => {
  const visible = await resolveVisibleEmployeeIdsForVisits(req);
  if (req.query.employeeId) {
    assertEmployeeVisible(visible, req.query.employeeId);
  }
  const data = await planItemService.buildTeamVisits(
    req.companyId,
    visible,
    req.query.date,
    req.context.timeZone,
    { employeeId: req.query.employeeId }
  );
  ApiResponse.success(res, data);
});

const markVisit = asyncHandler(async (req, res) => {
  const data = await planItemService.markVisit(
    req.companyId,
    req.params.id,
    req.body,
    req.user,
    req.context.timeZone,
    req.context.company
  );
  ApiResponse.success(res, data, 'Visit recorded');
});

const update = asyncHandler(async (req, res) => {
  const data = await planItemService.updateByAdmin(
    req.companyId,
    req.params.id,
    req.body,
    req.user,
    req.context.timeZone
  );
  ApiResponse.success(res, data, 'Plan item updated');
});

const reorder = asyncHandler(async (req, res) => {
  const data = await planItemService.reorderForDay(req.companyId, req.body, req.user, req.context.timeZone);
  ApiResponse.success(res, data, 'Visit order updated');
});

const checkCoVisitAvailability = asyncHandler(async (req, res) => {
  const data = await coVisitAvailabilityService.checkAvailability(
    req.companyId,
    req.query,
    req.context.timeZone
  );
  ApiResponse.success(res, data);
});

module.exports = { listToday, listTeamVisits, markVisit, update, reorder, checkCoVisitAvailability };
