const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * Manager Field Day — a planning declaration that a manager will spend a
 * company business day in the field with one or more medical reps.
 *
 * Isolated from WeeklyPlan.partnerByDay / PlanItem.participants:
 * this record does NOT inherit onto visits, attendance, or tracking.
 */
const managerFieldDaySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** The manager spending the day in the field. */
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Business-day start UTC (same anchor as PlanItem.date / Attendance.date). */
    date: { type: Date, required: true },
    /** Denormalized YYYY-MM-DD in the company timezone at write time. */
    dateYmd: { type: String, required: true, trim: true, maxlength: 10 },
    medicalRepIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: []
    },
    notes: { type: String, trim: true, maxlength: 2000, default: '' }
  },
  { timestamps: true }
);

managerFieldDaySchema.index(
  { companyId: 1, managerId: 1, date: 1 },
  { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);
managerFieldDaySchema.index({ companyId: 1, date: 1, medicalRepIds: 1 });
managerFieldDaySchema.index({ companyId: 1, managerId: 1, date: -1 });

managerFieldDaySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ManagerFieldDay', managerFieldDaySchema);
