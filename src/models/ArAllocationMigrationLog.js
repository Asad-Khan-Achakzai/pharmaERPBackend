const mongoose = require('mongoose');

/**
 * Audit trail for AR document-allocation migration (Option B).
 * Does not use onboarding MigrationAuditEvent (different lifecycle).
 */
const arAllocationMigrationLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', required: true, index: true },
    migrationRunId: { type: String, required: true, index: true },
    dryRun: { type: Boolean, default: true },
    applied: { type: Boolean, default: false },
    invariantsOk: { type: Boolean, default: false },
    pharmacyOpen: { type: Number },
    ledgerNet: { type: Number },
    exceptions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    returnPlans: { type: [mongoose.Schema.Types.Mixed], default: [] },
    collectionPlans: { type: [mongoose.Schema.Types.Mixed], default: [] },
    error: { type: String, default: null }
  },
  { timestamps: true }
);

arAllocationMigrationLogSchema.index({ companyId: 1, migrationRunId: 1, pharmacyId: 1 });

module.exports = mongoose.model('ArAllocationMigrationLog', arAllocationMigrationLogSchema);
