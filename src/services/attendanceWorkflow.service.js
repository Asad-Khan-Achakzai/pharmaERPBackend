const mongoose = require('mongoose');
const ApprovalMatrix = require('../models/ApprovalMatrix');
const AttendanceRequest = require('../models/AttendanceRequest');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const {
  ATTENDANCE_REQUEST_STATUS,
  ATTENDANCE_REQUEST_TYPE,
  ATTENDANCE_CHECKIN_SOURCE,
  ATTENDANCE_CHECKOUT_SOURCE,
  ATTENDANCE_STATUS,
  LATE_CHECKIN_APPROVAL_STATUS,
  NOTIFICATION_KIND,
  ROLES
} = require('../constants/enums');
const notificationService = require('./notification.service');
const attendancePolicyService = require('./attendancePolicy.service');
const attendanceAuditService = require('./attendanceAudit.service');
const { userHasPermission, userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { resolveAttendanceVisibleUserIds } = require('../utils/attendanceScope.util');

/** Config-free default when no ApprovalMatrix document exists. */
const BUILTIN_STEPS = [
  { order: 0, resolverType: 'DIRECT_MANAGER', requiredPermission: 'attendance.approve.direct' },
  { order: 1, resolverType: 'ADMIN_QUEUE', requiredPermission: 'admin.access' }
];

const COMPANY_AUTOMATION_SELECT =
  'attendanceApprovalsEnabled timeZone attendanceApprovalSlaHours attendanceSlaBreachAction attendanceEodEscalationEnabled attendanceEodEscalationAction attendancePendingAutoRejectHours';

const loadMatrix = async (companyId, requestCategory) => {
  const asOf = new Date();
  const base = {
    companyId,
    isActive: true,
    isDeleted: { $ne: true },
    effectiveFrom: { $lte: asOf },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }]
  };
  const specific = await ApprovalMatrix.findOne({
    ...base,
    requestCategory: requestCategory
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (specific) return specific;

  if (requestCategory !== 'ALL') {
    return ApprovalMatrix.findOne({ ...base, requestCategory: 'ALL' }).sort({ effectiveFrom: -1 }).lean();
  }
  return null;
};

const normalizeSteps = (matrix) => {
  const raw = matrix?.steps?.length ? matrix.steps : BUILTIN_STEPS;
  return raw.map((s, i) => ({ ...s, order: typeof s.order === 'number' ? s.order : i }));
};

/**
 * @param {object} requester - lean user with _id, managerId
 * @param {object[]} steps
 * @param {number} fromIndex
 */
const resolveRoutingFromStep = async (requester, steps, fromIndex) => {
  for (let i = fromIndex; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.resolverType === 'DIRECT_MANAGER') {
      if (requester.managerId) {
        return { stepIndex: i, currentApproverId: requester.managerId, adminPool: false };
      }
      continue;
    }
    if (s.resolverType === 'MANAGER_AT_DEPTH') {
      const depth = Math.max(1, Number(s.depth) || 1);
      let uid = requester.managerId;
      let d = 0;
      while (uid && d < depth) {
        if (d === depth - 1) {
          return { stepIndex: i, currentApproverId: uid, adminPool: false };
        }
        const u = await User.findOne({ _id: uid, isDeleted: { $ne: true } }).select('managerId').lean();
        uid = u?.managerId || null;
        d += 1;
      }
      continue;
    }
    if (s.resolverType === 'ADMIN_QUEUE') {
      return { stepIndex: i, currentApproverId: null, adminPool: true };
    }
  }
  return { stepIndex: Math.max(0, steps.length - 1), currentApproverId: null, adminPool: true };
};

const isActionableRequestStatus = (request) => {
  if (request.status === ATTENDANCE_REQUEST_STATUS.PENDING) return true;
  if (request.status === ATTENDANCE_REQUEST_STATUS.ESCALATED && request.adminPool) return true;
  return false;
};

async function notifyAttendanceRequestSubmitted({ companyId, request, requester, payload = {} }) {
  const targets = new Set();
  if (request.currentApproverId) {
    targets.add(String(request.currentApproverId));
  } else if (request.adminPool) {
    const admins = await User.find({
      companyId,
      role: ROLES.ADMIN,
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    admins.forEach((a) => targets.add(String(a._id)));
  }
  if (!targets.size) return;

  const requesterName = requester?.name || 'Team member';
  let title = 'Attendance request pending approval';
  let body = `${requesterName}: ${String(request.type || 'request').replace(/_/g, ' ').toLowerCase()}`;

  if (request.type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL) {
    title = 'Late check-in pending approval';
    const lateMinutes = payload?.lateMinutes;
    body =
      lateMinutes != null && Number(lateMinutes) > 0
        ? `${requesterName} checked in ${lateMinutes} min late`
        : `${requesterName} submitted a late check-in for approval`;
  }

  await Promise.all(
    [...targets].map((userId) =>
      notificationService
        .createForUser({
          companyId,
          userId,
          title,
          body,
          kind: NOTIFICATION_KIND.ATTENDANCE,
          link: '/(manager)/approvals',
          meta: { requestId: String(request._id), requestType: request.type }
        })
        .catch(() => null)
    )
  );
}

const logRequestWorkflowAudit = async ({ companyId, requestId, attendanceId, actorUserId, source, action, meta }) => {
  await attendanceAuditService.log({
    companyId,
    attendanceId: attendanceId || null,
    actorUserId: actorUserId || null,
    source,
    action,
    meta: { ...meta, requestId }
  });
};

const computeNextSlaDueAt = (company, fromDate = new Date()) => {
  const h = company?.attendanceApprovalSlaHours;
  if (h == null || Number(h) <= 0) return null;
  return new Date(fromDate.getTime() + Math.min(336, Math.max(0.25, Number(h))) * 3600000);
};

/** ObjectId or populated `{ _id, name, … }` from inbox/governance list APIs. */
const normalizeObjectIdRef = (ref) => {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'object' && ref._id != null) return String(ref._id);
  return String(ref);
};

/**
 * Walk requester → managers; true if viewerId appears in chain (viewer is manager-of-manager... of requester).
 */
const isUserAncestorOfRequester = async (companyId, viewerId, requesterId) => {
  const vid = String(viewerId);
  let uid = String(requesterId);
  for (let i = 0; i < 32; i += 1) {
    const u = await User.findOne({ _id: uid, companyId, isDeleted: { $ne: true } }).select('managerId').lean();
    if (!u?.managerId) return false;
    if (String(u.managerId) === vid) return true;
    uid = String(u.managerId);
  }
  return false;
};

const computeOversightBypass = async (companyId, actorUserId, isAdmin, reqUser, request, extra = {}) => {
  if (isAdmin || !reqUser) return false;
  const company =
    extra.preloadedCompany ??
    (await Company.findById(companyId).select('attendanceOversightInterventionEnabled').lean());
  if (!company?.attendanceOversightInterventionEnabled) return false;
  if (!userHasPermission(reqUser, 'attendance.approve.escalated')) return false;
  const requesterId = normalizeObjectIdRef(request.requesterId);
  if (!requesterId) return false;
  return isUserAncestorOfRequester(companyId, actorUserId, requesterId);
};

const assertActorCanAct = async (request, actorUserId, isAdmin, opts = {}) => {
  const { oversightBypass = false } = opts;
  if (!isActionableRequestStatus(request)) {
    throw new ApiError(400, 'Request is not pending');
  }
  if (isAdmin) return;
  if (request.adminPool) {
    throw new ApiError(403, 'Only an administrator can approve this step');
  }
  if (oversightBypass) return;
  const approverId = normalizeObjectIdRef(request.currentApproverId);
  if (approverId && approverId === String(actorUserId)) {
    return;
  }
  if (approverId) {
    const mgr = await User.findOne({
      _id: approverId,
      companyId: request.companyId,
      isDeleted: { $ne: true }
    })
      .select('attendanceApproveDelegateUserId attendanceApproveDelegateUntil')
      .lean();
    const until = mgr?.attendanceApproveDelegateUntil ? new Date(mgr.attendanceApproveDelegateUntil) : null;
    if (
      mgr?.attendanceApproveDelegateUserId &&
      String(mgr.attendanceApproveDelegateUserId) === String(actorUserId) &&
      until &&
      !Number.isNaN(until.getTime()) &&
      until.getTime() >= Date.now()
    ) {
      return;
    }
  }
  throw new ApiError(403, 'You are not the current approver for this request');
};

/**
 * Whether the viewer may approve/reject/escalate this request (same rules as assertActorCanAct, admin pool, etc.).
 * Used by list APIs so UIs can disable actions instead of failing on submit.
 */
const viewerMayActOnAttendanceRequest = async (companyId, request, viewerId, isAdmin, reqUser, extra = {}) => {
  if (!isActionableRequestStatus(request)) {
    return { canAct: false, readOnlyReason: 'This request is no longer open.' };
  }
  if (isAdmin) {
    return { canAct: true };
  }
  if (request.adminPool) {
    return {
      canAct: false,
      readOnlyReason: 'Only a company administrator can act on items in the admin queue.'
    };
  }
  try {
    const oversightBypass = await computeOversightBypass(companyId, viewerId, false, reqUser, request, extra);
    await assertActorCanAct(request, viewerId, false, { oversightBypass });
    return { canAct: true };
  } catch (e) {
    if (e instanceof ApiError && (e.statusCode === 403 || e.statusCode === 400)) {
      const msg = e.message || 'You cannot act on this request.';
      if (e.statusCode === 403 && msg.includes('not the current approver')) {
        return {
          canAct: false,
          readOnlyReason:
            'Waiting on the assigned approver for this step. You can follow progress here; only they (or an admin) can approve or reject right now unless your company allows senior-manager intervention.'
        };
      }
      return { canAct: false, readOnlyReason: msg };
    }
    return { canAct: false, readOnlyReason: 'You cannot act on this request right now.' };
  }
};

const parseApprovedInstant = (raw) => {
  if (raw == null || raw === '') return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const applyApprovedPayload = async (request, actorUserId) => {
  const { type, attendanceId } = request;
  if (!attendanceId) return;

  const att = await Attendance.findOne({ _id: attendanceId, companyId: request.companyId, isDeleted: { $ne: true } });
  if (!att) return;

  const rawPayload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) ? request.payload : {};
  const before = att.toObject();

  if (type === ATTENDANCE_REQUEST_TYPE.TIME_CORRECTION) {
    const cin = parseApprovedInstant(rawPayload.checkInTime);
    const cout = parseApprovedInstant(rawPayload.checkOutTime);
    if (cin) {
      att.checkInTime = cin;
      att.checkInSource = ATTENDANCE_CHECKIN_SOURCE.ADMIN;
    }
    if (cout) {
      att.checkOutTime = cout;
      att.checkOutSource = ATTENDANCE_CHECKOUT_SOURCE.ADMIN;
    }
    const line = `Time correction approved (request ${request._id}) — ${new Date().toISOString()}`;
    att.notes = att.notes ? `${att.notes}\n${line}` : line;
  } else if (type === ATTENDANCE_REQUEST_TYPE.MISSED_CHECKOUT) {
    const businessTime = require('../utils/businessTime');
    const cout =
      parseApprovedInstant(rawPayload.checkOutTime) || parseApprovedInstant(rawPayload.proposedCheckOutTime);
    if (att.checkInTime) {
      att.checkOutTime = cout || businessTime.utcNow();
      att.checkOutSource = ATTENDANCE_CHECKOUT_SOURCE.ADMIN;
    }
    const line = `Missed check-out approved — day closed (request ${request._id}) — ${new Date().toISOString()}`;
    att.notes = att.notes ? `${att.notes}\n${line}` : line;
  } else if (type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL || type === ATTENDANCE_REQUEST_TYPE.MANUAL_EXCEPTION) {
    if (type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL && att.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) {
      att.lateCheckInApprovalStatus = LATE_CHECKIN_APPROVAL_STATUS.APPROVED;
    }
    const line = `${type} approved (request ${request._id}) — ${new Date().toISOString()}`;
    att.notes = att.notes ? `${att.notes}\n${line}` : line;
  }

  att.activeRequestId = null;
  await att.save();

  const flags = await attendancePolicyService.getCompanyFlags(request.companyId);
  if (flags.attendanceGovernanceEnabled) {
    await attendanceAuditService.log({
      companyId: request.companyId,
      attendanceId: att._id,
      actorUserId,
      source: 'ADMIN',
      action: 'REQUEST_APPLIED',
      before,
      after: att.toObject(),
      meta: { requestId: request._id, requestType: type }
    });
  }
};

const submitRequest = async ({ companyId, requesterId, type, reason, payload, attendanceId }) => {
  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  if (!flags.attendanceApprovalsEnabled) {
    throw new ApiError(400, 'Attendance approvals are not enabled for this company');
  }
  if (!Object.values(ATTENDANCE_REQUEST_TYPE).includes(type)) {
    throw new ApiError(400, 'Invalid request type');
  }
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'Reason is required');
  }

  if (type === ATTENDANCE_REQUEST_TYPE.TIME_CORRECTION) {
    if (!attendanceId || !mongoose.Types.ObjectId.isValid(String(attendanceId))) {
      throw new ApiError(400, 'attendanceId is required for time correction');
    }
    const attForType = await Attendance.findOne({
      _id: attendanceId,
      companyId,
      employeeId: requesterId,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    if (!attForType) {
      throw new ApiError(400, 'Attendance record not found for this employee');
    }
  }

  if (type === ATTENDANCE_REQUEST_TYPE.MISSED_CHECKOUT) {
    if (!attendanceId || !mongoose.Types.ObjectId.isValid(String(attendanceId))) {
      throw new ApiError(400, 'attendanceId is required for missed check-out');
    }
    const attMc = await Attendance.findOne({
      _id: attendanceId,
      companyId,
      employeeId: requesterId,
      isDeleted: { $ne: true }
    })
      .select('checkInTime checkOutTime activeRequestId')
      .lean();
    if (!attMc?.checkInTime) {
      throw new ApiError(400, 'No check-in found for this workday — missed check-out cannot be submitted');
    }
    if (attMc.checkOutTime) {
      throw new ApiError(400, 'This workday already has a check-out');
    }
  }

  if (type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL && attendanceId && mongoose.Types.ObjectId.isValid(String(attendanceId))) {
    const dupOpen = await AttendanceRequest.findOne({
      companyId,
      requesterId,
      attendanceId,
      type: ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL,
      status: { $in: [ATTENDANCE_REQUEST_STATUS.PENDING, ATTENDANCE_REQUEST_STATUS.ESCALATED] },
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    if (dupOpen) {
      throw new ApiError(400, 'A late check-in is already waiting for manager approval. Duplicate request not allowed.');
    }
  }

  const requester = await User.findOne({
    _id: requesterId,
    companyId,
    isDeleted: { $ne: true }
  })
    .select('managerId companyId name')
    .lean();
  if (!requester) throw new ApiError(404, 'User not found');

  const matrix = await loadMatrix(companyId, type);
  const steps = normalizeSteps(matrix);
  const routing = await resolveRoutingFromStep(requester, steps, 0);

  let storedPayload = {};
  if (type === ATTENDANCE_REQUEST_TYPE.TIME_CORRECTION) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    if (p.checkInTime != null && p.checkInTime !== '') storedPayload.checkInTime = p.checkInTime;
    if (p.checkOutTime != null && p.checkOutTime !== '') storedPayload.checkOutTime = p.checkOutTime;
  } else if (type === ATTENDANCE_REQUEST_TYPE.MISSED_CHECKOUT) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const rawOut = p.checkOutTime != null && p.checkOutTime !== '' ? p.checkOutTime : p.proposedCheckOutTime;
    if (rawOut != null && rawOut !== '') storedPayload.checkOutTime = rawOut;
  }

  const company = await Company.findById(companyId).select(COMPANY_AUTOMATION_SELECT).lean();
  const slaDueAt = computeNextSlaDueAt(company, new Date());

  const doc = await AttendanceRequest.create({
    companyId,
    requesterId,
    attendanceId: attendanceId || null,
    type,
    status: ATTENDANCE_REQUEST_STATUS.PENDING,
    currentStepIndex: routing.stepIndex,
    stepsSnapshot: steps,
    matrixId: matrix?._id || null,
    currentApproverId: routing.currentApproverId,
    adminPool: routing.adminPool,
    reason: String(reason).trim(),
    payload: storedPayload,
    slaDueAt
  });

  if (attendanceId && mongoose.Types.ObjectId.isValid(String(attendanceId))) {
    await Attendance.findOneAndUpdate(
      { _id: attendanceId, companyId, employeeId: requesterId, isDeleted: { $ne: true } },
      { activeRequestId: doc._id }
    );
  }

  await logRequestWorkflowAudit({
    companyId,
    requestId: doc._id,
    attendanceId: doc.attendanceId,
    actorUserId: requesterId,
    source: 'USER',
    action: 'ATTENDANCE_REQUEST_CREATED',
    meta: { type, slaDueAt }
  });

  void notifyAttendanceRequestSubmitted({
    companyId,
    request: doc,
    requester,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  });

  return doc;
};

const approveRequest = async ({ companyId, requestId, actorUserId, isAdmin, comment, reqUser = null }) => {
  const request = await AttendanceRequest.findOne({
    _id: requestId,
    companyId,
    isDeleted: { $ne: true }
  });
  if (!request) throw new ApiError(404, 'Request not found');

  if (request.adminPool && !isAdmin) {
    throw new ApiError(403, 'Only an administrator can approve this request at this step');
  }
  const oversightBypass = await computeOversightBypass(companyId, actorUserId, isAdmin, reqUser, request);
  await assertActorCanAct(request, actorUserId, isAdmin, { oversightBypass });

  request.decisions.push({
    actorId: actorUserId,
    action: oversightBypass ? 'APPROVE_OVERSIGHT' : 'APPROVE',
    comment: comment || '',
    at: new Date(),
    source: 'USER'
  });

  const steps = request.stepsSnapshot || BUILTIN_STEPS;
  const nextIndex = request.currentStepIndex + 1;

  if (nextIndex >= steps.length) {
    request.status = ATTENDANCE_REQUEST_STATUS.APPROVED;
    request.currentApproverId = null;
    request.adminPool = false;
    await request.save();
    await applyApprovedPayload(request, actorUserId);
    await logRequestWorkflowAudit({
      companyId,
      requestId: request._id,
      attendanceId: request.attendanceId,
      actorUserId,
      source: isAdmin ? 'ADMIN' : 'USER',
      action: 'ATTENDANCE_REQUEST_FINAL_APPROVED',
      meta: {}
    });
    return request;
  }

  const requester = await User.findById(request.requesterId).select('managerId').lean();
  const nextRoute = await resolveRoutingFromStep(requester, steps, nextIndex);
  request.currentStepIndex = nextRoute.stepIndex;
  request.currentApproverId = nextRoute.currentApproverId;
  request.adminPool = nextRoute.adminPool;
  if (nextRoute.adminPool) {
    request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
  }
  const company = await Company.findById(companyId).select(COMPANY_AUTOMATION_SELECT).lean();
  request.slaDueAt = computeNextSlaDueAt(company, new Date());
  await request.save();

  await logRequestWorkflowAudit({
    companyId,
    requestId: request._id,
    attendanceId: request.attendanceId,
    actorUserId,
    source: isAdmin ? 'ADMIN' : 'USER',
    action: 'ATTENDANCE_REQUEST_APPROVED_STEP',
    meta: { stepIndex: request.currentStepIndex }
  });

  return request;
};

const rejectRequest = async ({ companyId, requestId, actorUserId, isAdmin, comment, reqUser = null }) => {
  const request = await AttendanceRequest.findOne({ _id: requestId, companyId, isDeleted: { $ne: true } });
  if (!request) throw new ApiError(404, 'Request not found');
  if (request.adminPool && !isAdmin) {
    throw new ApiError(403, 'Only an administrator can reject at this step');
  }
  const oversightBypass = await computeOversightBypass(companyId, actorUserId, isAdmin, reqUser, request);
  await assertActorCanAct(request, actorUserId, isAdmin, { oversightBypass });

  request.status = ATTENDANCE_REQUEST_STATUS.REJECTED;
  request.decisions.push({
    actorId: actorUserId,
    action: oversightBypass ? 'REJECT_OVERSIGHT' : 'REJECT',
    comment: comment || '',
    at: new Date(),
    source: 'USER'
  });
  request.currentApproverId = null;
  request.adminPool = false;
  request.slaDueAt = null;
  await request.save();

  if (request.attendanceId) {
    const att = await Attendance.findOne({ _id: request.attendanceId, companyId, isDeleted: { $ne: true } });
    if (
      att &&
      request.type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL &&
      att.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING
    ) {
      const before = att.toObject();
      att.checkInTime = null;
      att.checkInSource = undefined;
      att.lateMinutes = null;
      att.workShiftId = null;
      att.policyId = null;
      att.lateCheckInApprovalStatus = LATE_CHECKIN_APPROVAL_STATUS.REJECTED;
      att.status = ATTENDANCE_STATUS.ABSENT;
      att.activeRequestId = undefined;
      const line = `LATE_ARRIVAL rejected (request ${request._id}) — ${new Date().toISOString()}`;
      att.notes = att.notes ? `${att.notes}\n${line}` : line;
      await att.save();
      const flags = await attendancePolicyService.getCompanyFlags(companyId);
      if (flags.attendanceGovernanceEnabled) {
        await attendanceAuditService.log({
          companyId,
          attendanceId: att._id,
          actorUserId,
          source: 'ADMIN',
          action: 'LATE_CHECKIN_REQUEST_REJECTED',
          before,
          after: att.toObject(),
          meta: { requestId: request._id }
        });
      }
    } else {
      await Attendance.findOneAndUpdate(
        { _id: request.attendanceId, companyId, isDeleted: { $ne: true } },
        { $unset: { activeRequestId: 1 } }
      );
    }
  }

  await logRequestWorkflowAudit({
    companyId,
    requestId: request._id,
    attendanceId: request.attendanceId,
    actorUserId,
    source: isAdmin ? 'ADMIN' : 'USER',
    action: 'ATTENDANCE_REQUEST_REJECTED',
    meta: {}
  });

  return request;
};

const escalateRequest = async ({ companyId, requestId, actorUserId, isAdmin, comment, reqUser = null }) => {
  const request = await AttendanceRequest.findOne({ _id: requestId, companyId, isDeleted: { $ne: true } });
  if (!request) throw new ApiError(404, 'Request not found');
  if (!isActionableRequestStatus(request)) {
    throw new ApiError(400, 'Request is not pending');
  }
  if (!isAdmin) {
    const isRequester = String(request.requesterId) === String(actorUserId);
    if (!isRequester) {
      const oversightBypass = await computeOversightBypass(companyId, actorUserId, false, reqUser, request);
      await assertActorCanAct(request, actorUserId, false, { oversightBypass });
    }
  }

  const steps = request.stepsSnapshot || BUILTIN_STEPS;
  const nextIndex = request.currentStepIndex + 1;
  if (nextIndex >= steps.length) {
    /** Keep status actionable: company administrator queue (legacy rows used ESCALATED + dropped out of inbox). */
    request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
    request.adminPool = true;
    request.currentApproverId = null;
    request.decisions.push({
      actorId: actorUserId,
      action: 'ESCALATE_TO_ADMIN',
      comment: comment || '',
      at: new Date(),
      source: 'USER'
    });
    const company = await Company.findById(companyId).select(COMPANY_AUTOMATION_SELECT).lean();
    request.slaDueAt = computeNextSlaDueAt(company, new Date());
    await request.save();
    await logRequestWorkflowAudit({
      companyId,
      requestId: request._id,
      attendanceId: request.attendanceId,
      actorUserId,
      source: 'USER',
      action: 'ATTENDANCE_REQUEST_ESCALATED_TO_ADMIN_POOL',
      meta: {}
    });
    return request;
  }

  const requester = await User.findById(request.requesterId).select('managerId').lean();
  const nextRoute = await resolveRoutingFromStep(requester, steps, nextIndex);
  request.currentStepIndex = nextRoute.stepIndex;
  request.currentApproverId = nextRoute.currentApproverId;
  request.adminPool = nextRoute.adminPool;
  request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
  request.decisions.push({
    actorId: actorUserId,
    action: 'ESCALATE',
    comment: comment || '',
    at: new Date(),
    source: 'USER'
  });
  const company = await Company.findById(companyId).select(COMPANY_AUTOMATION_SELECT).lean();
  request.slaDueAt = computeNextSlaDueAt(company, new Date());
  await request.save();

  await logRequestWorkflowAudit({
    companyId,
    requestId: request._id,
    attendanceId: request.attendanceId,
    actorUserId,
    source: 'USER',
    action: 'ATTENDANCE_REQUEST_ESCALATED',
    meta: { stepIndex: request.currentStepIndex }
  });

  return request;
};

const actionableStatusQuery = () => ({
  $in: [ATTENDANCE_REQUEST_STATUS.PENDING, ATTENDANCE_REQUEST_STATUS.ESCALATED]
});

const actorIdFromDecision = (actorId) => {
  if (!actorId) return null;
  if (typeof actorId === 'object' && actorId !== null && '_id' in actorId) return String(actorId._id);
  return String(actorId);
};

/**
 * Additive response field `workflowTimeline` for enterprise UX (actor display names, no new DB fields).
 */
const attachWorkflowTimelines = async (rows) => {
  if (!rows || !rows.length) return rows;
  const ids = new Set();
  for (const r of rows) {
    for (const d of r.decisions || []) {
      const k = actorIdFromDecision(d.actorId);
      if (k) ids.add(k);
    }
  }
  let nameById = {};
  if (ids.size > 0) {
    const oidList = [...ids]
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (oidList.length) {
      const users = await User.find({ _id: { $in: oidList } }).select('name').lean();
      nameById = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
    }
  }
  return rows.map((r) => ({
    ...r,
    workflowTimeline: (r.decisions || []).map((d) => {
      const k = actorIdFromDecision(d.actorId);
      return {
        action: d.action,
        at: d.at,
        source: d.source || 'USER',
        comment: d.comment || '',
        actorName: k ? nameById[k] || null : null
      };
    })
  }));
};

const listInbox = async (companyId, actorUserId, { isAdmin, limit: limRaw, skip: skipRaw, sort: sortRaw, reqUser }) => {
  const limit = Math.min(Math.max(Number(limRaw) || 200, 1), 500);
  const skip = Math.min(Math.max(Number(skipRaw) || 0, 0), 10000);
  const sortDir = sortRaw === 'oldest' ? 1 : -1;

  const or = [{ currentApproverId: actorUserId }];
  if (!isAdmin) {
    const delegators = await User.find({
      companyId,
      attendanceApproveDelegateUserId: actorUserId,
      attendanceApproveDelegateUntil: { $gte: new Date() },
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    const mgrIds = delegators.map((d) => d._id);
    if (mgrIds.length) {
      or.push({ currentApproverId: { $in: mgrIds } });
    }
  }
  if (isAdmin) {
    or.push({ adminPool: true });
  }
  return AttendanceRequest.find({
    companyId,
    status: actionableStatusQuery(),
    isDeleted: { $ne: true },
    $or: or
  })
    .sort({ createdAt: sortDir })
    .skip(skip)
    .limit(limit)
    .populate('requesterId', 'name email')
    .populate('currentApproverId', 'name email')
    .populate('attendanceId', 'date checkInTime checkOutTime')
    .lean()
    .then(async (rows) => {
      const companyDoc = await Company.findById(companyId).select('attendanceOversightInterventionEnabled').lean();
      const withViewer = await Promise.all(
        rows.map(async (r) => {
          const act = await viewerMayActOnAttendanceRequest(companyId, r, actorUserId, isAdmin, reqUser, {
            preloadedCompany: companyDoc
          });
          return {
            ...r,
            viewerCanAct: act.canAct,
            viewerReadOnlyReason: act.readOnlyReason
          };
        })
      );
      return attachWorkflowTimelines(withViewer);
    });
};

/** True when governance queue may list every employee's requests (admins / company attendance). */
const canViewCompanyWideAttendanceRequests = (reqUser, isAdmin) => {
  if (isAdmin) return true;
  if (!reqUser) return false;
  return (
    userHasTenantWideAccess(reqUser) ||
    userHasPermission(reqUser, 'attendance.viewCompany')
  );
};

/** Company-wide actionable requests for administrators; managers see their team scope only. */
const listGovernanceRequestQueue = async (
  companyId,
  { limit: limRaw, skip: skipRaw, sort: sortRaw, viewerUserId, isAdmin, reqUser }
) => {
  const limit = Math.min(Math.max(Number(limRaw) || 200, 1), 500);
  const skip = Math.min(Math.max(Number(skipRaw) || 0, 0), 10000);
  const sortDir = sortRaw === 'oldest' ? 1 : -1;
  const now = Date.now();

  const query = {
    companyId,
    status: actionableStatusQuery(),
    isDeleted: { $ne: true }
  };

  if (!canViewCompanyWideAttendanceRequests(reqUser, isAdmin) && reqUser && viewerUserId) {
    const visibleRequesterIds = await resolveAttendanceVisibleUserIds(companyId, reqUser);
    const scopeOr = [];
    if (visibleRequesterIds.length) {
      scopeOr.push({ requesterId: { $in: visibleRequesterIds } });
    }
    const actorOid = mongoose.Types.ObjectId.isValid(String(viewerUserId))
      ? new mongoose.Types.ObjectId(String(viewerUserId))
      : null;
    if (actorOid) {
      scopeOr.push({ currentApproverId: actorOid });
    }
    if (scopeOr.length) {
      query.$or = scopeOr;
    } else {
      query.requesterId = { $in: [] };
    }
  }

  const rows = await AttendanceRequest.find(query)
    .sort({ createdAt: sortDir })
    .skip(skip)
    .limit(limit)
    .populate('requesterId', 'name email managerId')
    .populate('currentApproverId', 'name email')
    .populate('attendanceId', 'date checkInTime checkOutTime status lateCheckInApprovalStatus')
    .lean();

  const companyDoc = await Company.findById(companyId).select('attendanceOversightInterventionEnabled').lean();

  const withGov = await Promise.all(
    rows.map(async (r) => {
      const act = await viewerMayActOnAttendanceRequest(companyId, r, viewerUserId, isAdmin, reqUser, {
        preloadedCompany: companyDoc
      });
      return {
        ...r,
        governance: {
          slaDueAt: r.slaDueAt || null,
          slaMinutesRemaining:
            r.slaDueAt != null ? Math.round((new Date(r.slaDueAt).getTime() - now) / 60000) : null,
          isAdminQueue: Boolean(r.adminPool),
          currentStepDisplay: typeof r.currentStepIndex === 'number' ? r.currentStepIndex + 1 : 1,
          stepTotal: Array.isArray(r.stepsSnapshot) ? r.stepsSnapshot.length : 0,
          viewerCanAct: act.canAct,
          viewerReadOnlyReason: act.readOnlyReason || null
        }
      };
    })
  );
  return attachWorkflowTimelines(withGov);
};

/** Reporting-chain visibility: pending requests for people below the viewer (monitoring). */
const listOversightVisibleRequests = async (companyId, actorUserId, { limit: limRaw, sort: sortRaw }) => {
  const limit = Math.min(Math.max(Number(limRaw) || 100, 1), 300);
  const sortDir = sortRaw === 'oldest' ? 1 : -1;
  const rows = await AttendanceRequest.find({
    companyId,
    status: actionableStatusQuery(),
    isDeleted: { $ne: true }
  })
    .sort({ createdAt: sortDir })
    .limit(800)
    .populate('requesterId', 'name email')
    .populate('currentApproverId', 'name email')
    .populate('attendanceId', 'date checkInTime checkOutTime')
    .lean();

  const company = await Company.findById(companyId).select('attendanceOversightInterventionEnabled').lean();
  const intervention = Boolean(company?.attendanceOversightInterventionEnabled);

  const out = [];
  for (const r of rows) {
    const reqId = r.requesterId && typeof r.requesterId === 'object' ? r.requesterId._id : r.requesterId;
    if (!reqId) continue;
    const isAncestor = await isUserAncestorOfRequester(companyId, actorUserId, reqId);
    if (!isAncestor) continue;
    const holding = r.currentApproverId && (typeof r.currentApproverId === 'object' ? r.currentApproverId._id : r.currentApproverId);
    const isCurrent = holding && String(holding) === String(actorUserId);
    out.push({
      ...r,
      oversight: {
        visibility: intervention ? 'INTERVENTION_ALLOWED' : 'READ_ONLY',
        isYourTurn: Boolean(isCurrent),
        /** When not your turn, explain you are supervising this request. */
        monitorHint: isCurrent ? null : 'You can track this request for your team. Approve or reject when it is your step, unless intervention is on for your company.'
      }
    });
    if (out.length >= limit) break;
  }
  return attachWorkflowTimelines(out);
};

const listMyRequests = async (companyId, requesterId) => {
  const rows = await AttendanceRequest.find({ companyId, requesterId, isDeleted: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('currentApproverId', 'name email')
    .lean();
  return attachWorkflowTimelines(rows);
};

const applyAutomatedEscalation = async ({ requestId, companyId, action, auditKey, comment }) => {
  const request = await AttendanceRequest.findOne({ _id: requestId, companyId, isDeleted: { $ne: true } });
  if (!request || !isActionableRequestStatus(request)) return { skipped: true };

  if (request.lastAutoActionKey === auditKey) {
    return { skipped: true };
  }

  if (action === 'ADMIN_POOL') {
    request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
    request.adminPool = true;
    request.currentApproverId = null;
    request.decisions.push({
      actorId: null,
      action: 'POLICY_MOVE_TO_ADMIN',
      comment,
      at: new Date(),
      source: 'POLICY'
    });
  } else if (action === 'ESCALATE_NEXT') {
    const steps = request.stepsSnapshot || BUILTIN_STEPS;
    const nextIndex = request.currentStepIndex + 1;
    if (nextIndex >= steps.length) {
      request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
      request.adminPool = true;
      request.currentApproverId = null;
      request.decisions.push({
        actorId: null,
        action: 'POLICY_ESCALATE_TO_ADMIN',
        comment,
        at: new Date(),
        source: 'POLICY'
      });
    } else {
      const requester = await User.findById(request.requesterId).select('managerId').lean();
      const nextRoute = await resolveRoutingFromStep(requester, steps, nextIndex);
      request.currentStepIndex = nextRoute.stepIndex;
      request.currentApproverId = nextRoute.currentApproverId;
      request.adminPool = nextRoute.adminPool;
      request.status = ATTENDANCE_REQUEST_STATUS.PENDING;
      request.decisions.push({
        actorId: null,
        action: 'POLICY_ESCALATE_NEXT',
        comment,
        at: new Date(),
        source: 'POLICY'
      });
    }
  } else {
    return { skipped: true };
  }

  request.lastAutoActionKey = auditKey;
  request.lastAutoActionAt = new Date();
  const company = await Company.findById(companyId).select(COMPANY_AUTOMATION_SELECT).lean();
  request.slaDueAt = computeNextSlaDueAt(company, new Date());
  await request.save();

  await logRequestWorkflowAudit({
    companyId,
    requestId: request._id,
    attendanceId: request.attendanceId,
    actorUserId: null,
    source: 'SYSTEM',
    action: 'ATTENDANCE_REQUEST_POLICY_ESCALATION',
    meta: { auditKey, policyAction: action }
  });

  return { skipped: false };
};

const systemAutoRejectRequest = async ({ companyId, requestId, comment }) => {
  const request = await AttendanceRequest.findOne({ _id: requestId, companyId, isDeleted: { $ne: true } });
  if (!request || !isActionableRequestStatus(request)) return;
  if (request.type !== ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL) return;

  request.status = ATTENDANCE_REQUEST_STATUS.REJECTED;
  request.decisions.push({
    actorId: null,
    action: 'POLICY_AUTO_REJECT',
    comment,
    at: new Date(),
    source: 'POLICY'
  });
  request.currentApproverId = null;
  request.adminPool = false;
  request.slaDueAt = null;
  await request.save();

  if (request.attendanceId) {
    const att = await Attendance.findOne({ _id: request.attendanceId, companyId, isDeleted: { $ne: true } });
    if (att && att.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) {
      const before = att.toObject();
      att.checkInTime = null;
      att.checkInSource = undefined;
      att.lateMinutes = null;
      att.workShiftId = null;
      att.policyId = null;
      att.lateCheckInApprovalStatus = LATE_CHECKIN_APPROVAL_STATUS.REJECTED;
      att.status = ATTENDANCE_STATUS.ABSENT;
      att.activeRequestId = undefined;
      const line = `LATE_ARRIVAL auto-rejected (policy) (request ${request._id}) — ${new Date().toISOString()}`;
      att.notes = att.notes ? `${att.notes}\n${line}` : line;
      await att.save();
      const flags = await attendancePolicyService.getCompanyFlags(companyId);
      if (flags.attendanceGovernanceEnabled) {
        await attendanceAuditService.log({
          companyId,
          attendanceId: att._id,
          actorUserId: null,
          source: 'SYSTEM',
          action: 'LATE_CHECKIN_REQUEST_AUTO_REJECTED',
          before,
          after: att.toObject(),
          meta: { requestId: request._id }
        });
      }
    }
  }

  await logRequestWorkflowAudit({
    companyId,
    requestId: request._id,
    attendanceId: request.attendanceId,
    actorUserId: null,
    source: 'SYSTEM',
    action: 'ATTENDANCE_REQUEST_AUTO_REJECTED',
    meta: {}
  });
};

const runAttendanceRequestAutomationTick = async () => {
  const businessTime = require('../utils/businessTime');
  const companies = await Company.find({ isActive: true, isDeleted: { $ne: true } })
    .select(COMPANY_AUTOMATION_SELECT)
    .lean();

  const now = new Date();
  let processed = 0;

  for (const company of companies) {
    if (!company.attendanceApprovalsEnabled) continue;
    const cid = company._id;
    const requests = await AttendanceRequest.find({
      companyId: cid,
      status: actionableStatusQuery(),
      isDeleted: { $ne: true }
    })
      .limit(600)
      .lean();

    const tz = businessTime.getTimeZone(company);
    const localNow = businessTime.nowInBusinessTime(tz);
    const todayYmd = localNow.toISODate();

    for (const reqLean of requests) {
      const reqId = reqLean._id;

      if (company.attendancePendingAutoRejectHours && reqLean.type === ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL) {
        const hours = (now.getTime() - new Date(reqLean.createdAt).getTime()) / 3600000;
        if (hours >= company.attendancePendingAutoRejectHours) {
          await systemAutoRejectRequest({
            companyId: cid,
            requestId: reqId,
            comment: 'Automatic rejection: pending longer than company threshold'
          });
          processed += 1;
          continue;
        }
      }

      if (
        reqLean.slaDueAt &&
        company.attendanceSlaBreachAction &&
        company.attendanceSlaBreachAction !== 'NONE' &&
        now >= new Date(reqLean.slaDueAt)
      ) {
        const auditKey = `SLA_${String(reqId)}_${reqLean.slaDueAt ? new Date(reqLean.slaDueAt).getTime() : 0}`;
        const r = await applyAutomatedEscalation({
          requestId: reqId,
          companyId: cid,
          action: company.attendanceSlaBreachAction,
          auditKey,
          comment: 'Automatic escalation: response deadline passed (company SLA)'
        });
        if (!r.skipped) processed += 1;
        continue;
      }

      if (
        company.attendanceEodEscalationEnabled &&
        company.attendanceEodEscalationAction &&
        company.attendanceEodEscalationAction !== 'NONE' &&
        reqLean.attendanceId
      ) {
        const att = await Attendance.findById(reqLean.attendanceId).select('date').lean();
        if (att?.date) {
          const rowYmd = businessTime.businessDayKeyFromUtcInstant(att.date, tz);
          if (rowYmd < todayYmd) {
            const eodKey = `EOD_${rowYmd}_${String(reqId)}`;
            if (reqLean.lastAutoActionKey === eodKey) continue;
            const r = await applyAutomatedEscalation({
              requestId: reqId,
              companyId: cid,
              action: company.attendanceEodEscalationAction,
              auditKey: eodKey,
              comment: 'Automatic escalation: previous workday ended with no decision'
            });
            if (!r.skipped) processed += 1;
          }
        }
      }
    }
  }

  return processed;
};

/**
 * When a company administrator uses "Set today status" / correction, close linked workflow rows so attendance and request stay aligned.
 */
const resolveLinkedRequestsForAdminAttendanceOverride = async ({
  companyId,
  attendanceId,
  actorUserId,
  newAttendanceStatus,
  note
}) => {
  if (!attendanceId || !mongoose.Types.ObjectId.isValid(String(attendanceId))) return;
  const open = await AttendanceRequest.find({
    companyId,
    attendanceId,
    status: actionableStatusQuery(),
    isDeleted: { $ne: true }
  });

  for (const request of open) {
    const line = note || `Closed by company attendance correction — ${new Date().toISOString()}`;
    if (newAttendanceStatus === ATTENDANCE_STATUS.PRESENT) {
      request.status = ATTENDANCE_REQUEST_STATUS.APPROVED;
      request.currentApproverId = null;
      request.adminPool = false;
      request.slaDueAt = null;
      request.decisions.push({
        actorId: actorUserId,
        action: 'ADMIN_ATTENDANCE_OVERRIDE_APPROVE',
        comment: line,
        at: new Date(),
        source: 'ADMIN'
      });
      await request.save();
      await logRequestWorkflowAudit({
        companyId,
        requestId: request._id,
        attendanceId: request.attendanceId,
        actorUserId,
        source: 'ADMIN',
        action: 'ATTENDANCE_REQUEST_CLOSED_BY_ADMIN_OVERRIDE',
        meta: { attendanceStatus: newAttendanceStatus }
      });
    } else {
      request.status = ATTENDANCE_REQUEST_STATUS.CANCELLED;
      request.currentApproverId = null;
      request.adminPool = false;
      request.slaDueAt = null;
      request.decisions.push({
        actorId: actorUserId,
        action: 'ADMIN_ATTENDANCE_OVERRIDE_CANCEL',
        comment: line,
        at: new Date(),
        source: 'ADMIN'
      });
      await request.save();
      await logRequestWorkflowAudit({
        companyId,
        requestId: request._id,
        attendanceId: request.attendanceId,
        actorUserId,
        source: 'ADMIN',
        action: 'ATTENDANCE_REQUEST_CANCELLED_BY_ADMIN_OVERRIDE',
        meta: { attendanceStatus: newAttendanceStatus }
      });
    }
  }

  await Attendance.findOneAndUpdate(
    { _id: attendanceId, companyId, isDeleted: { $ne: true } },
    { $unset: { activeRequestId: 1 } }
  );
};

const getTodayExceptions = async (companyId, timeZone, { employeeIds = null } = {}) => {
  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  if (!flags.attendanceGovernanceEnabled && !flags.attendancePoliciesEnabled) {
    return { enabled: false, message: 'Turn on attendance tracking & schedules to see operational alerts.' };
  }

  const businessTime = require('../utils/businessTime');
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = businessTime.nowInBusinessTime(tz).toISODate();
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);

  const recQuery = { companyId, date: dateDoc, isDeleted: { $ne: true } };
  if (employeeIds && employeeIds.length) {
    recQuery.employeeId = { $in: employeeIds };
  }

  const recs = await Attendance.find(recQuery)
    .select('employeeId lateMinutes checkOutTime checkOutSource checkInTime status')
    .lean();

  const actionable = recs.filter((r) => r.status !== ATTENDANCE_STATUS.LEAVE);
  const late = actionable.filter((r) => (r.lateMinutes || 0) > 0);
  const missingCheckout = actionable.filter((r) => r.checkInTime && !r.checkOutTime);

  return {
    enabled: true,
    businessDate: ymd,
    lateCount: late.length,
    missingCheckoutCount: missingCheckout.length,
    lateEmployeeIds: late.map((r) => String(r.employeeId)),
    missingCheckoutEmployeeIds: missingCheckout.map((r) => String(r.employeeId)),
    excludesLeaveStatus: true
  };
};

module.exports = {
  BUILTIN_STEPS,
  loadMatrix,
  submitRequest,
  approveRequest,
  rejectRequest,
  escalateRequest,
  listInbox,
  listMyRequests,
  listGovernanceRequestQueue,
  listOversightVisibleRequests,
  getTodayExceptions,
  isUserAncestorOfRequester,
  runAttendanceRequestAutomationTick,
  resolveLinkedRequestsForAdminAttendanceOverride
};
