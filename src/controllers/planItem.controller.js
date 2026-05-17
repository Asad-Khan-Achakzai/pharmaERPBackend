const planItemService = require('../services/planItem.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');

const listToday = asyncHandler(async (req, res) => {
  let targetId = req.query.employeeId || req.user.userId;
  if (String(targetId) !== String(req.user.userId)) {
    if (userHasPermission(req.user, 'admin.access')) {
      /* ok */
    } else if (userHasPermission(req.user, 'team.viewAllReports')) {
      const subtree = await resolveSubtreeUserIds(req.companyId, req.user.userId, {
        includeSelf: true,
        activeOnly: true
      });
      const ok = subtree.some((id) => String(id) === String(targetId));
      if (!ok) {
        throw new ApiError(403, 'You can only view plan items for yourself or your team');
      }
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

module.exports = { listToday, markVisit, update, reorder };
