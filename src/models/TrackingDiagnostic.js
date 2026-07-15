const mongoose = require('mongoose');

/**
 * Device/tracking health events for Route History gap & quality analysis.
 * Mongo TTL is fixed at 90 days; soft purge should respect liveTracking.retentionDays.
 */
const trackingDiagnosticSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true, trim: true, maxlength: 64 },
    capturedAt: { type: Date, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

trackingDiagnosticSchema.index({ companyId: 1, userId: 1, capturedAt: -1 });
trackingDiagnosticSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('TrackingDiagnostic', trackingDiagnosticSchema);
