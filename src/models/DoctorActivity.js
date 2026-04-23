const mongoose = require('mongoose');
const { DOCTOR_ACTIVITY_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const doctorActivitySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    medicalRepId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    investedAmount: { type: Number, required: true },
    commitmentAmount: { type: Number, required: true },
    achievedSales: { type: Number, default: 0 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(DOCTOR_ACTIVITY_STATUS),
      default: DOCTOR_ACTIVITY_STATUS.ACTIVE
    }
  },
  { timestamps: true }
);

doctorActivitySchema.index({ companyId: 1, doctorId: 1, startDate: -1 });
doctorActivitySchema.index({ companyId: 1, status: 1, endDate: 1 });
doctorActivitySchema.index({ companyId: 1, medicalRepId: 1, startDate: -1 });
doctorActivitySchema.index({ companyId: 1, endDate: 1 });

doctorActivitySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('DoctorActivity', doctorActivitySchema);
