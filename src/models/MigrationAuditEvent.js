const mongoose = require('mongoose');

const migrationAuditEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    onboardingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OnboardingSession',
      required: true,
      index: true
    },
    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', default: null, index: true },
    eventType: {
      type: String,
      required: true,
      enum: [
        'SESSION_STARTED',
        'STEP_UPDATED',
        'IMPORT_QUEUED',
        'IMPORT_STARTED',
        'IMPORT_COMPLETED',
        'IMPORT_FAILED',
        'RECONCILIATION_GENERATED',
        'GO_LIVE_APPROVED',
        'GO_LIVE_COMPLETED',
        'ROLLBACK_REQUESTED',
        'ROLLBACK_COMPLETED'
      ]
    },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

migrationAuditEventSchema.index({ companyId: 1, onboardingSessionId: 1, createdAt: -1 });

module.exports = mongoose.model('MigrationAuditEvent', migrationAuditEventSchema);
