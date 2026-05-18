const mongoose = require('mongoose');

const importCommitSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', required: true, unique: true },
    entityType: { type: String, required: true, index: true },
    committedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    insertedCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    insertedIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    updatedIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

importCommitSchema.index({ companyId: 1, entityType: 1, createdAt: -1 });

module.exports = mongoose.model('ImportCommit', importCommitSchema);
