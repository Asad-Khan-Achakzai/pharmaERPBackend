const mongoose = require('mongoose');
const { IMPORT_MODE, IMPORT_JOB_STATUS } = require('../constants/onboarding');

const importJobSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    entityType: {
      type: String,
      required: true,
      enum: [
        'products',
        'doctors',
        'pharmacies',
        'distributors',
        'employees',
        'territories',
        'openingStock',
        'openingBalances',
        'salesHistory',
        'returnsHistory',
        'collectionsHistory',
        'visitsHistory',
        'targetsHistory'
      ],
      index: true
    },
    mode: { type: String, enum: Object.values(IMPORT_MODE), required: true, default: IMPORT_MODE.DRY_RUN },
    status: {
      type: String,
      enum: Object.values(IMPORT_JOB_STATUS),
      required: true,
      default: IMPORT_JOB_STATUS.QUEUED,
      index: true
    },
    idempotencyKey: { type: String, trim: true, default: null, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    file: {
      originalName: { type: String, trim: true },
      storageKey: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      sizeBytes: { type: Number, min: 0 }
    },
    mapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    metrics: {
      totalRows: { type: Number, default: 0 },
      validRows: { type: Number, default: 0 },
      invalidRows: { type: Number, default: 0 },
      skippedRows: { type: Number, default: 0 },
      committedRows: { type: Number, default: 0 }
    },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: {
      code: { type: String, trim: true, default: null },
      message: { type: String, trim: true, default: null }
    }
  },
  { timestamps: true }
);

importJobSchema.index({ companyId: 1, status: 1, createdAt: -1 });
importJobSchema.index({ onboardingSessionId: 1, entityType: 1, createdAt: -1 });
importJobSchema.index(
  { companyId: 1, entityType: 1, mode: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('ImportJob', importJobSchema);
