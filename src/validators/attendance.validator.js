const Joi = require('joi');

const markAttendanceSchema = Joi.object({
  checkOutTime: Joi.date().optional(),
  notes: Joi.string().trim().max(500).allow(''),
  date: Joi.date().optional()
});

/** Optional note shown on the manager’s late check-in request (strict late + approvals). */
const checkinBodySchema = Joi.object({
  reason: Joi.string().trim().max(500).allow('', null).optional()
}).default({});

/** Calendar dates only — avoid Joi.date() on query strings (coerces to Date and breaks report toYmd). */
const reportQuerySchema = Joi.object({
  employeeId: Joi.string().required(),
  startDate: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required(),
  endDate: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required()
});

const monthlySummaryQuerySchema = Joi.object({
  employeeId: Joi.string().required(),
  month: Joi.string().pattern(/^\d{4}-\d{2}$/).required()
});

const adminMarkAbsentTodaySchema = Joi.object({
  employeeId: Joi.string().required()
});

const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE'];

const adminSetTodayStatusSchema = Joi.object({
  employeeId: Joi.string().required(),
  status: Joi.string().valid(...ATTENDANCE_STATUSES).required()
});

const governancePatchSchema = Joi.object({
  attendanceGovernanceEnabled: Joi.boolean().optional(),
  attendancePoliciesEnabled: Joi.boolean().optional(),
  attendanceApprovalsEnabled: Joi.boolean().optional(),
  strictLateBlocking: Joi.boolean().optional(),
  allowCheckInWhenLate: Joi.boolean().optional(),
  autoRequestOnLateCheckIn: Joi.boolean().optional(),
  attendanceApprovalSlaHours: Joi.number().min(0.25).max(336).allow(null).optional(),
  attendanceSlaBreachAction: Joi.string().valid('NONE', 'ESCALATE_NEXT', 'ADMIN_POOL').optional(),
  attendanceEodEscalationEnabled: Joi.boolean().optional(),
  attendanceEodEscalationAction: Joi.string().valid('NONE', 'ESCALATE_NEXT', 'ADMIN_POOL').optional(),
  attendanceOversightInterventionEnabled: Joi.boolean().optional(),
  attendancePendingAutoRejectHours: Joi.number().min(1).max(720).allow(null).optional()
}).min(1);

const governanceQueueQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).optional(),
  skip: Joi.number().integer().min(0).max(10000).optional(),
  sort: Joi.string().valid('newest', 'oldest').optional()
});

const oversightQueueQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(300).optional(),
  sort: Joi.string().valid('newest', 'oldest').optional()
});

const myApprovalDelegationSchema = Joi.object({
  delegateUserId: Joi.string().hex().length(24).allow(null, ''),
  delegateUntil: Joi.date().allow(null)
}).min(1);

const workShiftBodySchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  startMinutes: Joi.number().integer().min(0).max(1439).required(),
  endMinutes: Joi.number().integer().min(0).max(1439).required(),
  shiftEndsNextDay: Joi.boolean().optional(),
  graceMinutes: Joi.number().integer().min(0).max(600).optional(),
  postShiftCheckInCutoffMinutes: Joi.number().integer().min(0).max(720).optional(),
  minWorkMinutes: Joi.number().integer().min(0).optional().allow(null),
  halfDayThresholdMinutes: Joi.number().integer().min(0).optional().allow(null),
  isDefault: Joi.boolean().optional(),
  notes: Joi.string().trim().max(500).optional().allow('')
});

const attendancePolicyBodySchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  workShiftId: Joi.string().required(),
  isDefault: Joi.boolean().optional(),
  extensions: Joi.object().optional()
});

const policyAssignmentBodySchema = Joi.object({
  policyId: Joi.string().required(),
  employeeId: Joi.string().optional().allow(null, ''),
  effectiveFrom: Joi.date().optional(),
  effectiveTo: Joi.date().optional().allow(null)
});

const approvalMatrixStepSchema = Joi.object({
  order: Joi.number().integer().min(0).max(99).optional(),
  resolverType: Joi.string().valid('DIRECT_MANAGER', 'MANAGER_AT_DEPTH', 'ADMIN_QUEUE').required(),
  depth: Joi.number().integer().min(1).max(20).when('resolverType', {
    is: 'MANAGER_AT_DEPTH',
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  requiredPermission: Joi.string().trim().max(120).optional().allow('')
}).unknown(false);

const approvalMatrixBodySchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  requestCategory: Joi.string()
    .valid('ALL', 'LATE_ARRIVAL', 'MISSED_CHECKOUT', 'TIME_CORRECTION', 'MANUAL_EXCEPTION')
    .optional(),
  steps: Joi.array().items(approvalMatrixStepSchema).min(1).required(),
  isActive: Joi.boolean().optional(),
  effectiveFrom: Joi.date().optional(),
  effectiveTo: Joi.date().optional().allow(null)
});

const approvalMatrixPatchSchema = Joi.object({
  name: Joi.string().trim().max(120).optional(),
  requestCategory: Joi.string()
    .valid('ALL', 'LATE_ARRIVAL', 'MISSED_CHECKOUT', 'TIME_CORRECTION', 'MANUAL_EXCEPTION')
    .optional(),
  steps: Joi.array().items(approvalMatrixStepSchema).min(1).optional(),
  isActive: Joi.boolean().optional(),
  effectiveFrom: Joi.date().optional(),
  effectiveTo: Joi.date().optional().allow(null)
}).min(1);

const isoInstant = Joi.alternatives().try(Joi.string().trim().max(44), Joi.date());

const timeCorrectionPayloadSchema = Joi.object({
  checkInTime: isoInstant.optional(),
  checkOutTime: isoInstant.optional()
})
  .or('checkInTime', 'checkOutTime')
  .unknown(false);

const missedCheckoutPayloadSchema = Joi.object({
  checkOutTime: isoInstant.optional(),
  proposedCheckOutTime: isoInstant.optional()
}).unknown(false);

const submitAttendanceRequestSchema = Joi.object({
  type: Joi.string().valid('LATE_ARRIVAL', 'MISSED_CHECKOUT', 'TIME_CORRECTION', 'MANUAL_EXCEPTION').required(),
  reason: Joi.string().trim().max(2000).required(),
  attendanceId: Joi.when('type', {
    is: Joi.valid('TIME_CORRECTION', 'MISSED_CHECKOUT'),
    then: Joi.string().hex().length(24).required(),
    otherwise: Joi.string().optional().allow('', null)
  }),
  payload: Joi.when('type', {
    switch: [
      { is: 'TIME_CORRECTION', then: timeCorrectionPayloadSchema.required() },
      { is: 'MISSED_CHECKOUT', then: missedCheckoutPayloadSchema.optional().default({}) }
    ],
    otherwise: Joi.object().optional().default({}).max(0)
  })
}).unknown(false);

const requestCommentSchema = Joi.object({
  comment: Joi.string().trim().max(2000).allow('', null)
}).default({});

const inboxQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).optional(),
  skip: Joi.number().integer().min(0).max(10000).optional(),
  sort: Joi.string().valid('newest', 'oldest').optional()
});

const policyAssignmentBulkBodySchema = Joi.object({
  policyId: Joi.string().hex().length(24).required(),
  employeeIds: Joi.array().items(Joi.string().hex().length(24)).min(1).max(500).required()
}).unknown(false);

module.exports = {
  markAttendanceSchema,
  checkinBodySchema,
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
  submitAttendanceRequestSchema,
  requestCommentSchema,
  inboxQuerySchema
};
