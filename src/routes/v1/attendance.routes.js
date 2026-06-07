const express = require('express');
const router = express.Router();
const c = require('../../controllers/attendance.controller');
const g = require('../../controllers/attendanceGovernance.controller');
const live = require('../../controllers/liveTracking.controller');
const { authenticate } = require('../../middleware/auth');
const { companyScope } = require('../../middleware/companyScope');
const { clientUuid } = require('../../middleware/clientUuid');
const { checkPermission, checkPermissionAny } = require('../../middleware/checkPermission');
const { validate, validateQuery } = require('../../middleware/validate');
const {
  markAttendanceSchema,
  reportQuerySchema,
  monthlySummaryQuerySchema,
  adminMarkAbsentTodaySchema,
  adminSetTodayStatusSchema,
  governancePatchSchema,
  workShiftBodySchema,
  attendancePolicyBodySchema,
  policyAssignmentBodySchema,
  policyAssignmentBulkBodySchema,
  approvalMatrixBodySchema,
  approvalMatrixPatchSchema,
  governanceQueueQuerySchema,
  oversightQueueQuerySchema,
  myApprovalDelegationSchema,
  checkinBodySchema,
  checkoutBodySchema,
  submitAttendanceRequestSchema,
  requestCommentSchema,
  inboxQuerySchema
} = require('../../validators/attendance.validator');
const { heartbeatSchema } = require('../../validators/phase2.validator');

router.use(authenticate, companyScope, clientUuid());

router.post('/heartbeat', validate(heartbeatSchema), live.heartbeat);
router.get(
  '/live',
  checkPermissionAny('team.view', 'team.viewAllReports', 'attendance.viewTeam', 'admin.access'),
  live.live
);

router.post('/mark', checkPermission('attendance.mark'), validate(markAttendanceSchema), c.mark);
/** Self-service: only `req.user.userId` — any authenticated company user may check in/out and read own today. */
router.post('/checkin', validate(checkinBodySchema), c.checkin);
router.post('/checkout', validate(checkoutBodySchema), c.checkout);
router.get('/me/today', c.meToday);
router.get(
  '/today',
  checkPermissionAny('attendance.view', 'attendance.viewTeam', 'attendance.viewCompany'),
  c.today
);
router.post(
  '/admin/mark-absent-today',
  checkPermissionAny('admin.access', 'attendance.override'),
  validate(adminMarkAbsentTodaySchema),
  c.adminMarkAbsentToday
);
router.post(
  '/admin/set-today-status',
  checkPermissionAny('admin.access', 'attendance.override'),
  validate(adminSetTodayStatusSchema),
  c.adminSetTodayStatus
);
router.get(
  '/report',
  checkPermissionAny('attendance.view', 'attendance.viewTeam', 'attendance.viewCompany'),
  validateQuery(reportQuerySchema),
  c.report
);
router.get(
  '/monthly-summary',
  checkPermissionAny('attendance.view', 'attendance.viewTeam', 'attendance.viewCompany'),
  validateQuery(monthlySummaryQuerySchema),
  c.monthlySummary
);

/** Governance (all flags default off — no behaviour change until enabled). */
router.get('/governance/settings', checkPermissionAny('admin.access', 'attendance.governance.view'), g.getGovernanceSettings);
router.patch(
  '/governance/settings',
  checkPermission('admin.access'),
  validate(governancePatchSchema),
  g.patchGovernanceSettings
);
router.get(
  '/governance/work-shifts',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.listWorkShifts
);
router.post(
  '/governance/work-shifts',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(workShiftBodySchema),
  g.createWorkShift
);
router.delete(
  '/governance/work-shifts/:id',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.deleteWorkShift
);
router.get(
  '/governance/policies',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.listPolicies
);
router.post(
  '/governance/policies',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(attendancePolicyBodySchema),
  g.createPolicy
);
router.get(
  '/governance/policy-assignments',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.listPolicyAssignments
);
router.post(
  '/governance/policy-assignments',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(policyAssignmentBodySchema),
  g.createPolicyAssignment
);
router.post(
  '/governance/policy-assignments/bulk',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(policyAssignmentBulkBodySchema),
  g.bulkCreatePolicyAssignments
);
router.delete(
  '/governance/policy-assignments/:id',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.deletePolicyAssignment
);
router.get(
  '/governance/approval-matrices',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.listApprovalMatrices
);
router.post(
  '/governance/approval-matrices',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(approvalMatrixBodySchema),
  g.createApprovalMatrix
);
router.patch(
  '/governance/approval-matrices/:id',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  validate(approvalMatrixPatchSchema),
  g.updateApprovalMatrix
);
router.delete(
  '/governance/approval-matrices/:id',
  checkPermissionAny('admin.access', 'attendance.matrix.manage'),
  g.deleteApprovalMatrix
);
router.get(
  '/governance/exceptions/today',
  checkPermissionAny(
    'admin.access',
    'attendance.governance.view',
    'attendance.viewEscalations',
    'team.viewAllReports',
    'attendance.viewCompany'
  ),
  g.todayAttendanceExceptions
);

router.get(
  '/governance/monitoring/summary',
  checkPermissionAny('admin.access', 'attendance.governance.view', 'attendance.matrix.manage'),
  g.attendanceMonitoringSummary
);

router.get(
  '/governance/request-queue',
  checkPermissionAny('admin.access', 'attendance.governance.view'),
  validateQuery(governanceQueueQuerySchema),
  g.listGovernanceRequestQueue
);
router.patch(
  '/governance/my-approval-delegation',
  checkPermissionAny(
    'admin.access',
    'attendance.approve',
    'attendance.approve.direct',
    'attendance.approve.escalated'
  ),
  validate(myApprovalDelegationSchema),
  g.patchMyApprovalDelegation
);

router.post(
  '/requests',
  checkPermission('attendance.request.create'),
  validate(submitAttendanceRequestSchema),
  g.submitAttendanceRequest
);
router.get(
  '/requests/inbox',
  checkPermissionAny(
    'admin.access',
    'attendance.approve',
    'attendance.approve.direct',
    'attendance.approve.escalated'
  ),
  validateQuery(inboxQuerySchema),
  g.attendanceInbox
);
router.get(
  '/requests/oversight',
  checkPermissionAny(
    'admin.access',
    'attendance.approve.escalated',
    'attendance.viewEscalations',
    'attendance.viewCompany'
  ),
  validateQuery(oversightQueueQuerySchema),
  g.listOversightAttendanceRequests
);
router.get('/requests/mine', g.myAttendanceRequests);
router.post(
  '/requests/:id/approve',
  checkPermissionAny(
    'admin.access',
    'attendance.approve',
    'attendance.approve.direct',
    'attendance.approve.escalated'
  ),
  validate(requestCommentSchema),
  g.approveAttendanceRequest
);
router.post(
  '/requests/:id/reject',
  checkPermissionAny(
    'admin.access',
    'attendance.approve',
    'attendance.approve.direct',
    'attendance.approve.escalated'
  ),
  validate(requestCommentSchema),
  g.rejectAttendanceRequest
);
router.post(
  '/requests/:id/escalate',
  checkPermissionAny(
    'admin.access',
    'attendance.request.create',
    'attendance.approve',
    'attendance.approve.direct',
    'attendance.approve.escalated'
  ),
  validate(requestCommentSchema),
  g.escalateAttendanceRequest
);

module.exports = router;
