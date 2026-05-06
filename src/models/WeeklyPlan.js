const mongoose = require('mongoose');
const { WEEKLY_PLAN_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

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
