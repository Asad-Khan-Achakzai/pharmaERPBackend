const mongoose = require('mongoose');
const { PLAN_ITEM_TYPE, PLAN_ITEM_STATUS, UNPLANNED_VISIT_REASON } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const planItemSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    weeklyPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'WeeklyPlan', required: true },
    /** Medical rep assigned (matches WeeklyPlan.medicalRepId). */
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Calendar day (aligned with Attendance.date storage — business day start in UTC). */
    date: { type: Date, required: true },
    /** Visit route order for the rep on this calendar day (1-based). */
    sequenceOrder: { type: Number, required: true, min: 1 },
    /** Optional display hint (e.g. "10:30") — not enforced server-side. */
    plannedTime: { type: String, trim: true, maxlength: 32 },
    /** Wall time when execution was recorded (VISITED). */
    actualVisitTime: { type: Date, default: null },
    /** Ad-hoc field visit — exempt from duplicate-doctor-per-day index. */
    isUnplanned: { type: Boolean, default: false },
    type: { type: String, enum: Object.values(PLAN_ITEM_TYPE), required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    title: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: Object.values(PLAN_ITEM_STATUS), default: PLAN_ITEM_STATUS.PENDING },
    /** Execution audit: out-of-sequence completion (requires reason unless STRICT_VISIT_SEQUENCE blocks it). */
    wasOutOfOrder: { type: Boolean, default: false },
    outOfOrderReason: { type: String, trim: true, maxlength: 500, default: null },
    /** Set for isUnplanned rows — reason taxonomy for field-force analytics. */
    unplannedReason: { type: String, enum: Object.values(UNPLANNED_VISIT_REASON), default: null },
    visitLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'VisitLog', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

planItemSchema.index({ companyId: 1, employeeId: 1, date: 1 });
planItemSchema.index({ weeklyPlanId: 1, date: 1 });
planItemSchema.index(
  { companyId: 1, employeeId: 1, date: 1, sequenceOrder: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: { $ne: true } }
  }
);
planItemSchema.index(
  { companyId: 1, employeeId: 1, date: 1, doctorId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      doctorId: { $exists: true, $ne: null },
      type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
      isDeleted: { $ne: true },
      isUnplanned: { $ne: true }
    }
  }
);

planItemSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PlanItem', planItemSchema);
