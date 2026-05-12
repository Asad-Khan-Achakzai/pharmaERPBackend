const mongoose = require('mongoose');
const Company = require('../models/Company');
const WorkShift = require('../models/WorkShift');
const AttendancePolicy = require('../models/AttendancePolicy');
const PolicyAssignment = require('../models/PolicyAssignment');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const ApprovalMatrix = require('../models/ApprovalMatrix');
const attendanceWorkflowService = require('../services/attendanceWorkflow.service');
const attendanceMonitoringService = require('../services/attendanceMonitoring.service');
const attendanceAuditService = require('../services/attendanceAudit.service');
const { resolveAttendanceVisibleUserIds } = require('../utils/attendanceScope.util');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../utils/ApiError');
const { userHasPermission } = require('../utils/effectivePermissions');

const governanceSelect =
  'attendanceGovernanceEnabled attendancePoliciesEnabled attendanceApprovalsEnabled strictLateBlocking allowCheckInWhenLate autoRequestOnLateCheckIn attendanceApprovalSlaHours attendanceSlaBreachAction attendanceEodEscalationEnabled attendanceEodEscalationAction attendanceOversightInterventionEnabled attendancePendingAutoRejectHours name';

const tz = (req) => req.context.timeZone;

function normalizeApprovalMatrixSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return [];
  return steps.map((s, i) => {
    const resolverType = s.resolverType;
    let requiredPermission =
      s.requiredPermission != null && String(s.requiredPermission).trim()
        ? String(s.requiredPermission).trim()
        : '';
    if (!requiredPermission) {
      if (resolverType === 'DIRECT_MANAGER') requiredPermission = 'attendance.approve.direct';
      else if (resolverType === 'MANAGER_AT_DEPTH') requiredPermission = 'attendance.approve.escalated';
      else if (resolverType === 'ADMIN_QUEUE') requiredPermission = 'admin.access';
    }
    const row = {
      order: i,
      resolverType,
      requiredPermission
    };
    if (resolverType === 'MANAGER_AT_DEPTH' && s.depth != null) {
      row.depth = Number(s.depth);
    }
    return row;
  });
}

const getGovernanceSettings = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access') && !userHasPermission(req.user, 'attendance.governance.view')) {
    throw new ApiError(403, 'Forbidden');
  }
  const c = await Company.findById(req.companyId).select(governanceSelect).lean();
  ApiResponse.success(res, c);
});

const patchGovernanceSettings = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Only company administrators can change attendance settings');
  }
  const body = req.body || {};
  const allowed = {};
  for (const k of [
    'attendanceGovernanceEnabled',
    'attendancePoliciesEnabled',
    'attendanceApprovalsEnabled',
    'strictLateBlocking',
    'allowCheckInWhenLate',
    'autoRequestOnLateCheckIn',
    'attendanceEodEscalationEnabled',
    'attendanceOversightInterventionEnabled'
  ]) {
    if (body[k] !== undefined) allowed[k] = Boolean(body[k]);
  }
  if (body.attendanceApprovalSlaHours !== undefined) {
    if (body.attendanceApprovalSlaHours === null) {
      allowed.attendanceApprovalSlaHours = null;
    } else {
      const n = Number(body.attendanceApprovalSlaHours);
      if (!Number.isNaN(n)) allowed.attendanceApprovalSlaHours = Math.min(336, Math.max(0.25, n));
    }
  }
  if (body.attendancePendingAutoRejectHours !== undefined) {
    if (body.attendancePendingAutoRejectHours === null) {
      allowed.attendancePendingAutoRejectHours = null;
    } else {
      const n = Number(body.attendancePendingAutoRejectHours);
      if (!Number.isNaN(n)) allowed.attendancePendingAutoRejectHours = Math.min(720, Math.max(1, n));
    }
  }
  for (const k of ['attendanceSlaBreachAction', 'attendanceEodEscalationAction']) {
    if (body[k] !== undefined && ['NONE', 'ESCALATE_NEXT', 'ADMIN_POOL'].includes(String(body[k]))) {
      allowed[k] = String(body[k]);
    }
  }
  if (!Object.keys(allowed).length) throw new ApiError(400, 'No valid fields to update');
  const c = await Company.findByIdAndUpdate(req.companyId, { $set: allowed }, { new: true }).select(governanceSelect);
  ApiResponse.success(res, c, 'Settings saved');
});

const listWorkShifts = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const rows = await WorkShift.find({ companyId: req.companyId, isDeleted: { $ne: true } }).sort({ name: 1 }).lean();
  ApiResponse.success(res, rows);
});

const createWorkShift = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await WorkShift.create({ ...req.body, companyId: req.companyId });
  ApiResponse.created(res, doc);
});

/** Soft-delete a work shift when no assignments remain. Past attendance rows are unlinked (workShiftId / policyId cleared), not deleted. */
const deleteWorkShift = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new ApiError(400, 'Invalid schedule id');
  }
  const shift = await WorkShift.findOne({ _id: id, companyId: req.companyId });
  if (!shift) {
    throw new ApiError(404, 'Schedule not found');
  }

  const linkedPolicies = await AttendancePolicy.find({
    companyId: req.companyId,
    workShiftId: shift._id
  }).select('_id');

  for (const pol of linkedPolicies) {
    const assignmentCount = await PolicyAssignment.countDocuments({
      companyId: req.companyId,
      policyId: pol._id
    });
    if (assignmentCount > 0) {
      throw new ApiError(
        400,
        'Cannot delete this schedule while people or a company-wide assignment still use it. Remove those assignments first.'
      );
    }
  }

  const policyObjectIds = linkedPolicies.map((p) => p._id);

  await Attendance.updateMany(
    { companyId: req.companyId, workShiftId: shift._id },
    { $set: { workShiftId: null } }
  );
  if (policyObjectIds.length > 0) {
    await Attendance.updateMany(
      { companyId: req.companyId, policyId: { $in: policyObjectIds } },
      { $set: { policyId: null } }
    );
  }

  for (const pol of linkedPolicies) {
    const polDoc = await AttendancePolicy.findById(pol._id);
    if (polDoc) {
      await polDoc.softDelete(req.user.userId);
    }
  }

  await shift.softDelete(req.user.userId);
  ApiResponse.success(res, null, 'Schedule deleted');
});

const listPolicies = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const rows = await AttendancePolicy.find({ companyId: req.companyId, isDeleted: { $ne: true } })
    .populate('workShiftId', 'name startMinutes endMinutes graceMinutes shiftEndsNextDay')
    .sort({ name: 1 })
    .lean();
  ApiResponse.success(res, rows);
});

const createPolicy = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await AttendancePolicy.create({ ...req.body, companyId: req.companyId });
  ApiResponse.created(res, doc);
});

const listPolicyAssignments = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const rows = await PolicyAssignment.find({ companyId: req.companyId, isDeleted: { $ne: true } })
    .populate('policyId', 'name')
    .sort({ effectiveFrom: -1 })
    .limit(500)
    .lean();
  ApiResponse.success(res, rows);
});

const createPolicyAssignment = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await PolicyAssignment.create({ ...req.body, companyId: req.companyId });
  ApiResponse.created(res, doc);
});

const bulkCreatePolicyAssignments = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const { policyId, employeeIds } = req.body || {};
  if (!policyId || !mongoose.Types.ObjectId.isValid(String(policyId))) {
    throw new ApiError(400, 'Invalid schedule link');
  }
  const pol = await AttendancePolicy.findOne({
    _id: policyId,
    companyId: req.companyId,
    isDeleted: { $ne: true }
  }).select('_id');
  if (!pol) throw new ApiError(404, 'Schedule link not found');

  const ids = Array.isArray(employeeIds)
    ? [...new Set(employeeIds.map((id) => String(id)).filter((id) => mongoose.Types.ObjectId.isValid(id)))]
    : [];
  if (!ids.length) throw new ApiError(400, 'employeeIds must contain at least one valid user id');

  const users = await User.find({
    _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    companyId: req.companyId,
    isDeleted: { $ne: true }
  })
    .select('_id')
    .lean();
  if (users.length !== ids.length) {
    throw new ApiError(400, 'One or more employees are not in this company');
  }

  const items = await PolicyAssignment.insertMany(
    ids.map((employeeId) => ({
      companyId: req.companyId,
      policyId: pol._id,
      employeeId: new mongoose.Types.ObjectId(employeeId)
    }))
  );
  ApiResponse.success(res, { created: items.length }, 'Assignments saved');
});

const deletePolicyAssignment = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await PolicyAssignment.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!doc) throw new ApiError(404, 'Assignment not found');
  await doc.softDelete(req.user.userId);
  ApiResponse.success(res, null, 'Assignment removed');
});

const listApprovalMatrices = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const rows = await ApprovalMatrix.find({ companyId: req.companyId, isDeleted: { $ne: true } })
    .sort({ effectiveFrom: -1, updatedAt: -1, name: 1 })
    .lean();
  ApiResponse.success(res, rows);
});

const createApprovalMatrix = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const payload = { ...req.body, companyId: req.companyId };
  if (Array.isArray(payload.steps)) {
    payload.steps = normalizeApprovalMatrixSteps(payload.steps);
  }
  const doc = await ApprovalMatrix.create(payload);
  ApiResponse.created(res, doc);
});

const updateApprovalMatrix = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new ApiError(400, 'Invalid matrix id');
  }
  const b = req.body || {};
  const allowed = {};
  if (b.name !== undefined) allowed.name = String(b.name).trim().slice(0, 120);
  if (b.requestCategory !== undefined) allowed.requestCategory = b.requestCategory;
  if (b.steps !== undefined) allowed.steps = normalizeApprovalMatrixSteps(b.steps);
  if (b.isActive !== undefined) allowed.isActive = Boolean(b.isActive);
  if (b.effectiveFrom !== undefined) allowed.effectiveFrom = b.effectiveFrom;
  if (b.effectiveTo !== undefined) allowed.effectiveTo = b.effectiveTo;
  if (!Object.keys(allowed).length) throw new ApiError(400, 'No valid fields to update');

  const doc = await ApprovalMatrix.findOne({ _id: id, companyId: req.companyId, isDeleted: { $ne: true } });
  if (!doc) throw new ApiError(404, 'Approval route not found');
  Object.assign(doc, allowed);
  await doc.save();
  ApiResponse.success(res, doc, 'Route updated');
});

const deleteApprovalMatrix = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.matrix.manage') && !userHasPermission(req.user, 'admin.access')) {
    throw new ApiError(403, 'Forbidden');
  }
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new ApiError(400, 'Invalid matrix id');
  }
  const doc = await ApprovalMatrix.findOne({ _id: id, companyId: req.companyId, isDeleted: { $ne: true } });
  if (!doc) throw new ApiError(404, 'Approval route not found');
  await doc.softDelete(req.user.userId);
  ApiResponse.success(res, null, 'Route removed');
});

const submitAttendanceRequest = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'attendance.request.create')) {
    throw new ApiError(403, 'You cannot submit attendance requests');
  }
  const { type, reason, payload, attendanceId } = req.body;
  const doc = await attendanceWorkflowService.submitRequest({
    companyId: req.companyId,
    requesterId: req.user.userId,
    type,
    reason,
    payload,
    attendanceId: attendanceId || null
  });
  ApiResponse.created(res, doc, 'Request submitted');
});

const attendanceInbox = asyncHandler(async (req, res) => {
  const isAdmin = userHasPermission(req.user, 'admin.access');
  if (
    !isAdmin &&
    !userHasPermission(req.user, 'attendance.approve') &&
    !userHasPermission(req.user, 'attendance.approve.direct') &&
    !userHasPermission(req.user, 'attendance.approve.escalated')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const { limit, skip, sort } = req.query;
  const rows = await attendanceWorkflowService.listInbox(req.companyId, req.user.userId, {
    isAdmin,
    limit,
    skip,
    sort,
    reqUser: req.user
  });
  ApiResponse.success(res, rows);
});

const myAttendanceRequests = asyncHandler(async (req, res) => {
  const rows = await attendanceWorkflowService.listMyRequests(req.companyId, req.user.userId);
  ApiResponse.success(res, rows);
});

const approveAttendanceRequest = asyncHandler(async (req, res) => {
  const isAdmin = userHasPermission(req.user, 'admin.access');
  if (
    !isAdmin &&
    !userHasPermission(req.user, 'attendance.approve') &&
    !userHasPermission(req.user, 'attendance.approve.direct') &&
    !userHasPermission(req.user, 'attendance.approve.escalated')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await attendanceWorkflowService.approveRequest({
    companyId: req.companyId,
    requestId: req.params.id,
    actorUserId: req.user.userId,
    isAdmin,
    comment: req.body?.comment,
    reqUser: req.user
  });
  ApiResponse.success(res, doc, 'Request approved');
});

const rejectAttendanceRequest = asyncHandler(async (req, res) => {
  const isAdmin = userHasPermission(req.user, 'admin.access');
  if (
    !isAdmin &&
    !userHasPermission(req.user, 'attendance.approve') &&
    !userHasPermission(req.user, 'attendance.approve.direct') &&
    !userHasPermission(req.user, 'attendance.approve.escalated')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const doc = await attendanceWorkflowService.rejectRequest({
    companyId: req.companyId,
    requestId: req.params.id,
    actorUserId: req.user.userId,
    isAdmin,
    comment: req.body?.comment,
    reqUser: req.user
  });
  ApiResponse.success(res, doc, 'Request rejected');
});

const escalateAttendanceRequest = asyncHandler(async (req, res) => {
  const isAdmin = userHasPermission(req.user, 'admin.access');
  const doc = await attendanceWorkflowService.escalateRequest({
    companyId: req.companyId,
    requestId: req.params.id,
    actorUserId: req.user.userId,
    isAdmin,
    comment: req.body?.comment,
    reqUser: req.user
  });
  ApiResponse.success(res, doc, 'Request updated');
});

/** Company-wide actionable attendance requests (administrator / governance visibility). */
const listGovernanceRequestQueue = asyncHandler(async (req, res) => {
  if (!userHasPermission(req.user, 'admin.access') && !userHasPermission(req.user, 'attendance.governance.view')) {
    throw new ApiError(403, 'Forbidden');
  }
  const { limit, skip, sort } = req.query;
  const isAdmin = userHasPermission(req.user, 'admin.access');
  const rows = await attendanceWorkflowService.listGovernanceRequestQueue(req.companyId, {
    limit,
    skip,
    sort,
    viewerUserId: req.user.userId,
    isAdmin,
    reqUser: req.user
  });
  ApiResponse.success(res, rows);
});

/** Managers higher in the chain: visibility into team members’ pending requests. */
const listOversightAttendanceRequests = asyncHandler(async (req, res) => {
  if (
    !userHasPermission(req.user, 'admin.access') &&
    !userHasPermission(req.user, 'attendance.approve.escalated') &&
    !userHasPermission(req.user, 'attendance.viewEscalations') &&
    !userHasPermission(req.user, 'attendance.viewCompany')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const { limit, sort } = req.query;
  const rows = await attendanceWorkflowService.listOversightVisibleRequests(req.companyId, req.user.userId, {
    limit,
    sort
  });
  ApiResponse.success(res, rows);
});

const patchMyApprovalDelegation = asyncHandler(async (req, res) => {
  if (
    !userHasPermission(req.user, 'admin.access') &&
    !userHasPermission(req.user, 'attendance.approve') &&
    !userHasPermission(req.user, 'attendance.approve.direct') &&
    !userHasPermission(req.user, 'attendance.approve.escalated')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const { delegateUserId, delegateUntil } = req.body || {};
  const hasId = delegateUserId != null && String(delegateUserId).trim() !== '';
  const hasUntil = delegateUntil != null && delegateUntil !== '';

  const user = await User.findOne({ _id: req.user.userId, companyId: req.companyId, isDeleted: { $ne: true } });
  if (!user) throw new ApiError(404, 'User not found');

  if (!hasId && !hasUntil) {
    user.attendanceApproveDelegateUserId = null;
    user.attendanceApproveDelegateUntil = null;
  } else {
    if (!hasId || !hasUntil) {
      throw new ApiError(400, 'Provide both delegate user and end date, or send empty values to clear.');
    }
    const delUser = await User.findOne({
      _id: delegateUserId,
      companyId: req.companyId,
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    if (!delUser) throw new ApiError(400, 'Delegate not found or inactive');
    if (String(delUser._id) === String(user._id)) {
      throw new ApiError(400, 'Cannot delegate to yourself');
    }
    const until = delegateUntil instanceof Date ? delegateUntil : new Date(delegateUntil);
    if (Number.isNaN(until.getTime())) throw new ApiError(400, 'Invalid end date');
    if (until.getTime() < Date.now()) throw new ApiError(400, 'End date must be in the future');
    user.attendanceApproveDelegateUserId = delUser._id;
    user.attendanceApproveDelegateUntil = until;
  }

  await user.save();

  await attendanceAuditService.log({
    companyId: req.companyId,
    attendanceId: null,
    actorUserId: req.user.userId,
    source: 'USER',
    action: 'ATTENDANCE_APPROVAL_DELEGATION_UPDATED',
    meta: {
      delegateUserId: user.attendanceApproveDelegateUserId,
      until: user.attendanceApproveDelegateUntil
    }
  });

  ApiResponse.success(res, {
    attendanceApproveDelegateUserId: user.attendanceApproveDelegateUserId,
    attendanceApproveDelegateUntil: user.attendanceApproveDelegateUntil
  });
});

const todayAttendanceExceptions = asyncHandler(async (req, res) => {
  if (
    !userHasPermission(req.user, 'admin.access') &&
    !userHasPermission(req.user, 'attendance.governance.view') &&
    !userHasPermission(req.user, 'attendance.viewEscalations') &&
    !userHasPermission(req.user, 'team.viewAllReports') &&
    !userHasPermission(req.user, 'attendance.viewCompany')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const visible = await resolveAttendanceVisibleUserIds(req.companyId, req.user);
  const data = await attendanceWorkflowService.getTodayExceptions(req.companyId, tz(req), { employeeIds: visible });
  ApiResponse.success(res, data);
});

const attendanceMonitoringSummary = asyncHandler(async (req, res) => {
  if (
    !userHasPermission(req.user, 'admin.access') &&
    !userHasPermission(req.user, 'attendance.governance.view') &&
    !userHasPermission(req.user, 'attendance.matrix.manage')
  ) {
    throw new ApiError(403, 'Forbidden');
  }
  const data = await attendanceMonitoringService.getSummary(req.companyId);
  ApiResponse.success(res, data);
});

module.exports = {
  getGovernanceSettings,
  patchGovernanceSettings,
  listWorkShifts,
  createWorkShift,
  deleteWorkShift,
  listPolicies,
  createPolicy,
  listPolicyAssignments,
  createPolicyAssignment,
  bulkCreatePolicyAssignments,
  deletePolicyAssignment,
  listApprovalMatrices,
  createApprovalMatrix,
  updateApprovalMatrix,
  deleteApprovalMatrix,
  submitAttendanceRequest,
  attendanceInbox,
  listGovernanceRequestQueue,
  listOversightAttendanceRequests,
  myAttendanceRequests,
  approveAttendanceRequest,
  rejectAttendanceRequest,
  escalateAttendanceRequest,
  patchMyApprovalDelegation,
  todayAttendanceExceptions,
  attendanceMonitoringSummary
};
