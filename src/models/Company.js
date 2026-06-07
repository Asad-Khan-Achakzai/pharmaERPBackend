const mongoose = require('mongoose');
const { Info } = require('luxon');
const { softDeletePlugin } = require('../plugins/softDelete');

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, default: 'Pakistan' },
    phone: { type: String, trim: true },
    /** Pakistan FBR National Tax Number — printed on delivery invoices. */
    ntnNo: { type: String, trim: true, maxlength: 64 },
    email: { type: String, trim: true, lowercase: true },
    logo: { type: String },
    currency: { type: String, default: 'PKR' },
    /** Starting bank/cash position for implied cash balance (collections + settlements − outflows) */
    cashOpeningBalance: { type: Number, default: 0 },
    /**
     * Per-tenant feature flag (Phase 2B). When true, weekly plans require manager approval
     * before they go ACTIVE. New plans inherit this flag at creation; flipping it later
     * affects only future plans.
     */
    weeklyPlanApprovalRequired: { type: Boolean, default: false },
    /**
     * When true, reps cannot mark a visit out of planned sequence (same effect as env STRICT_VISIT_SEQUENCE=1).
     */
    strictVisitSequence: { type: Boolean, default: false },
    /**
     * When true, users may set `coverageTerritoryIds` (additional Zone/Area/Brick nodes).
     * `territoryId` remains the primary node; ownership queries union primary + extras.
     */
    mrepMultiTerritory: { type: Boolean, default: false },
    /** When true, doctor assignment changes append `DoctorOwnershipEvent` rows (additive audit). */
    mrepOwnershipAudit: { type: Boolean, default: false },
    /**
     * Attendance governance (all default false — production-safe; enable per company).
     * When false, behaviour matches legacy check-in/out with additive audit fields only.
     */
    attendanceGovernanceEnabled: { type: Boolean, default: false },
    /** When true, WorkShift / policy assignment affects late detection and /me/today hints. */
    attendancePoliciesEnabled: { type: Boolean, default: false },
    /** When true, AttendanceRequest workflow + inbox APIs are active. */
    attendanceApprovalsEnabled: { type: Boolean, default: false },
    /** When true, check-in after grace + late blocks until overridden (requires policies). */
    strictLateBlocking: { type: Boolean, default: false },
    /**
     * When true with strictLateBlocking + policies + late check-in, employee check-in still records (lateMinutes kept).
     * Default false preserves legacy hard-block for tenants that already enabled strict mode.
     */
    allowCheckInWhenLate: { type: Boolean, default: false },
    /**
     * When true with attendanceApprovalsEnabled + lateMinutes on check-in, submit a linked LATE_ARRIVAL workflow (non-blocking).
     */
    autoRequestOnLateCheckIn: { type: Boolean, default: false },
    /** Onboarding controls (enterprise rollout) */
    onboardingEnabled: { type: Boolean, default: false },
    onboardingStrictValidation: { type: Boolean, default: false },
    onboardingKillSwitch: { type: Boolean, default: false },
    onboardingPilotCohort: { type: String, trim: true, maxlength: 64, default: '' },
    /**
     * Attendance request automation (all optional; defaults preserve legacy behaviour).
     */
    /** Hours after submission when SLA timer fires (null = no SLA-based automation). */
    attendanceApprovalSlaHours: { type: Number, default: null, min: 0.25, max: 336 },
    /** When SLA elapses: NONE (default), ESCALATE_NEXT, ADMIN_POOL */
    attendanceSlaBreachAction: {
      type: String,
      enum: ['NONE', 'ESCALATE_NEXT', 'ADMIN_POOL'],
      default: 'NONE'
    },
    /** After company-local close of the attendance workday, run attendanceEodEscalationAction once per request/day. */
    attendanceEodEscalationEnabled: { type: Boolean, default: false },
    attendanceEodEscalationAction: {
      type: String,
      enum: ['NONE', 'ESCALATE_NEXT', 'ADMIN_POOL'],
      default: 'NONE'
    },
    /** Allow managers in the requester’s reporting chain to act (approve/reject/escalate) before the step is theirs. */
    attendanceOversightInterventionEnabled: { type: Boolean, default: false },
    /**
     * Optional: auto-reject pending late-arrival requests after N hours (compliance / hygiene).
     * Null = disabled. Uses same clock as SLA.
     */
    attendancePendingAutoRejectHours: { type: Number, default: null, min: 1, max: 720 },
    /** Single canonical IANA timezone for business calendar (reports, plans, attendance anchors). Required at creation — no implicit UTC. */
    timeZone: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(v) {
          return Info.isValidIANAZone(String(v || '').trim());
        },
        message: 'Company timeZone must be a valid IANA timezone identifier'
      }
    },
    isActive: { type: Boolean, default: true },
    /**
     * Mobile feature flags (Phase 0 additive). All default false so existing
     * companies remain unaffected until explicitly opted in.
     */
    mobileEnabled: { type: Boolean, default: true },
    mobilePushEnabled: { type: Boolean, default: false },
    attendanceGeofenceEnabled: { type: Boolean, default: false },
    doctorApprovalRequired: { type: Boolean, default: false },
    liveTrackingEnabled: { type: Boolean, default: false },
    /**
     * When true, field expenses from mobile stay PENDING until a manager approves
     * and GL is posted. Default false — existing tenants auto-post on create.
     */
    expenseApprovalRequired: { type: Boolean, default: false }
  },
  { timestamps: true }
);

companySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Company', companySchema);
