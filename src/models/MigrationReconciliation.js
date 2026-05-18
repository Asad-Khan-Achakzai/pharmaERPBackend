const mongoose = require('mongoose');

const mismatchSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    sourceValue: { type: mongoose.Schema.Types.Mixed, default: null },
    targetValue: { type: mongoose.Schema.Types.Mixed, default: null },
    delta: { type: mongoose.Schema.Types.Mixed, default: null },
    message: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const migrationReconciliationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', default: null, index: true },
    entityType: { type: String, required: true, index: true },
    sourceCount: { type: Number, default: 0 },
    targetCount: { type: Number, default: 0 },
    sourceAmount: { type: Number, default: null },
    targetAmount: { type: Number, default: null },
    status: { type: String, enum: ['MATCHED', 'MISMATCHED', 'REVIEW_REQUIRED'], default: 'REVIEW_REQUIRED' },
    mismatches: { type: [mismatchSchema], default: [] },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

migrationReconciliationSchema.index({ companyId: 1, entityType: 1, createdAt: -1 });

module.exports = mongoose.model('MigrationReconciliation', migrationReconciliationSchema);
