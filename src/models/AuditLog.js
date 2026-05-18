const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  entityType: { type: String, required: true },
  /**
   * Some bulk/system events do not map to a single entity row.
   * Keep nullable so imports and onboarding flows remain fully auditable.
   */
  entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
  changes: { type: mongoose.Schema.Types.Mixed },
  ipAddress: { type: String },
  timestamp: { type: Date, default: Date.now }
});

auditLogSchema.index({ companyId: 1, timestamp: -1 });
auditLogSchema.index(
  { companyId: 1, entityType: 1, entityId: 1 },
  { partialFilterExpression: { entityId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
