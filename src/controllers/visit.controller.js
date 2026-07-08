const visitLogService = require('../services/visitLog.service');
const activeVisitService = require('../services/activeVisit.service');
const ApiResponse = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../middleware/asyncHandler');
const { userHasPermission } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');

const assertEmployeeVisible = (visibleEmployeeIds, targetId) => {
  if (visibleEmployeeIds === null) return;
  const ok = visibleEmployeeIds.some((id) => String(id) === String(targetId));
  if (!ok) {
    throw new ApiError(403, 'You can only view active visits for yourself or your team');
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

const unplanned = asyncHandler(async (req, res) => {
  const data = await visitLogService.createUnplanned(
    req.companyId,
    req.body,
    req.user,
    req.context.timeZone,
    req.context.company
  );
  ApiResponse.created(res, data, 'Unplanned visit logged');
});

const listActive = asyncHandler(async (req, res) => {
  const visible = await resolveVisibleEmployeeIdsForVisits(req);
  const targetId = req.query.employeeId || req.user.userId;
  if (String(targetId) !== String(req.user.userId)) {
    assertEmployeeVisible(visible, targetId);
  }
  const items = await activeVisitService.listActive(req.companyId, visible, {
    employeeId: targetId
  });
  ApiResponse.success(res, { items });
});

const listTeamActive = asyncHandler(async (req, res) => {
  const visible = await resolveVisibleEmployeeIdsForVisits(req);
  if (req.query.employeeId) {
    assertEmployeeVisible(visible, req.query.employeeId);
  }
  const items = await activeVisitService.listActive(req.companyId, visible, {
    employeeId: req.query.employeeId
  });
  ApiResponse.success(res, { items });
});

const upsertActive = asyncHandler(async (req, res) => {
  const data = await activeVisitService.upsertActive(req.companyId, req.user.userId, req.body);
  ApiResponse.success(res, data, 'Active visit saved');
});

const clearActive = asyncHandler(async (req, res) => {
  await activeVisitService.clearActive(req.companyId, req.user.userId, req.params.clientUuid);
  ApiResponse.success(res, null, 'Active visit cleared');
});

module.exports = { unplanned, listActive, listTeamActive, upsertActive, clearActive };
