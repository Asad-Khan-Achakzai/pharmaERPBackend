const mongoose = require('mongoose');
const { IMPORT_ROW_STATUS } = require('../constants/onboarding');

const rowErrorSchema = new mongoose.Schema(
  {
    field: { type: String, trim: true, default: null },
    code: { type: String, trim: true, default: null },
    message: { type: String, trim: true, required: true }
  },
  { _id: false }
);

const importJobRowSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', required: true, index: true },
    rowNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(IMPORT_ROW_STATUS),
      default: IMPORT_ROW_STATUS.PENDING,
      index: true
    },
    source: { type: mongoose.Schema.Types.Mixed, default: {} },
    normalizedPayload: { type: mongoose.Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, trim: true, default: null },
    errors: { type: [rowErrorSchema], default: [] },
    commitResult: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

importJobRowSchema.index({ importJobId: 1, rowNumber: 1 }, { unique: true });
importJobRowSchema.index({ companyId: 1, importJobId: 1, status: 1 });

module.exports = mongoose.model('ImportJobRow', importJobRowSchema);
