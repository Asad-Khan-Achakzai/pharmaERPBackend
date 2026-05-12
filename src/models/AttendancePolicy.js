const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const attendancePolicySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    workShiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkShift', required: true },
    isDefault: { type: Boolean, default: false },
    /** Future: JSON rules (Ramadan overrides, regional). */
    extensions: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

attendancePolicySchema.index({ companyId: 1, isDefault: 1 });
attendancePolicySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('AttendancePolicy', attendancePolicySchema);
