const mongoose = require('mongoose');
const { PLAN_ITEM_TYPE, PLAN_ITEM_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const planItemSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    weeklyPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'WeeklyPlan', required: true },
    /** Medical rep assigned (matches WeeklyPlan.medicalRepId). */
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Calendar day (aligned with Attendance.date storage — Pacific day as UTC midnight). */
    date: { type: Date, required: true },
    type: { type: String, enum: Object.values(PLAN_ITEM_TYPE), required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    title: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 2000 },
    status: { type: String, enum: Object.values(PLAN_ITEM_STATUS), default: PLAN_ITEM_STATUS.PENDING },
    visitLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'VisitLog', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

planItemSchema.index({ companyId: 1, employeeId: 1, date: 1 });
planItemSchema.index({ weeklyPlanId: 1, date: 1 });
planItemSchema.index(
  { companyId: 1, employeeId: 1, date: 1, doctorId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      doctorId: { $exists: true, $ne: null },
      type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
      isDeleted: { $ne: true }
    }
  }
);

planItemSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PlanItem', planItemSchema);
