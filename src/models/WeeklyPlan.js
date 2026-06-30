const mongoose = require('mongoose');
const { WEEKLY_PLAN_STATUS, CHECKIN_POLICY_TYPE } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const checkInCustomLocationSchema = new mongoose.Schema(
  {
    locationName: { type: String, trim: true, maxlength: 200, default: '' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    radiusMeters: { type: Number, default: 150, min: 25, max: 5000 }
  },
  { _id: false }
);

const checkInConfigurationSchema = new mongoose.Schema(
  {
    policyType: {
      type: String,
      enum: Object.values(CHECKIN_POLICY_TYPE),
      default: CHECKIN_POLICY_TYPE.COMPANY_DEFAULT
    },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    customLocation: { type: checkInCustomLocationSchema, default: undefined }
  },
  { _id: false }
);

/**
 * Per-day CP (call point) selection. Each weekday references a CallPoint from the
 * company's Admin-managed CP master. Used as the highest-priority source for the
 * daily check-in distance validation (resolved by weekday of the check-in date).
 */
const cpByDaySchema = new mongoose.Schema(
  {
    monday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    tuesday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    wednesday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    thursday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    friday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    saturday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null },
    sunday: { type: mongoose.Schema.Types.ObjectId, ref: 'CallPoint', default: null }
  },
  { _id: false }
);

const visitSchema = new mongoose.Schema(
  {
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    planned: { type: Boolean, default: true },
    completed: { type: Boolean, default: false },
    notes: { type: String }
  },
  { _id: false }
);

const weeklyPlanSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Medical rep / employee this plan is assigned to (same as employeeId in PlanItem). */
    medicalRepId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    weekStartDate: { type: Date, required: true },
    weekEndDate: { type: Date, required: true },
    doctorVisits: [visitSchema],
    distributorVisits: [visitSchema],
    notes: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: Object.values(WEEKLY_PLAN_STATUS), default: WEEKLY_PLAN_STATUS.DRAFT },
    /**
     * Manager approval workflow (Phase 2B). Defaults to false; set from
     * Company.weeklyPlanApprovalRequired at create time. Per-plan flag so a company can
     * toggle the policy without rewriting in-flight plans.
     */
    approvalRequired: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedReason: { type: String, trim: true, maxlength: 1000, default: null },
    /** Check-in point override for this week (V2 only; ignored when company mode = LEGACY). */
    checkInConfiguration: { type: checkInConfigurationSchema, default: undefined },
    /** Per-day CP selected from the CP master; highest-priority check-in coordinate source. */
    cpByDay: { type: cpByDaySchema, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

weeklyPlanSchema.index({ companyId: 1, medicalRepId: 1, weekStartDate: -1 });
/** Manager dashboards filter by status (e.g. "pending approval"). */
weeklyPlanSchema.index({ companyId: 1, status: 1, submittedAt: -1 });

weeklyPlanSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('WeeklyPlan', weeklyPlanSchema);
