const mongoose = require('mongoose');
const {
  DOCTOR_LOCATION_SUGGESTION_SOURCE,
  DOCTOR_LOCATION_SUGGESTION_STATUS
} = require('../constants/enums');

const doctorLocationSuggestionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    submittedByEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    gpsAccuracy: { type: Number, default: null },
    source: {
      type: String,
      enum: Object.values(DOCTOR_LOCATION_SUGGESTION_SOURCE),
      default: DOCTOR_LOCATION_SUGGESTION_SOURCE.VISIT_COMPLETION
    },
    status: {
      type: String,
      enum: Object.values(DOCTOR_LOCATION_SUGGESTION_STATUS),
      default: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING,
      index: true
    },
    submittedAt: { type: Date, default: Date.now, index: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: null }
  },
  { timestamps: true }
);

doctorLocationSuggestionSchema.index({ companyId: 1, status: 1, submittedAt: -1 });
doctorLocationSuggestionSchema.index(
  { doctorId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING }
  }
);

module.exports = mongoose.model('DoctorLocationSuggestion', doctorLocationSuggestionSchema);
