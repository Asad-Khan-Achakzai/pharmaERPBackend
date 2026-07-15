const mongoose = require('mongoose');

/**
 * Append-only location pings for optional live rep tracking.
 * Latest row per user is used for manager live map; clientUuid supports idempotent replay.
 *
 * Retention:
 * - Mongo TTL index below is fixed at 90 days (expireAfterSeconds cannot read company config).
 * - Soft purge / analytics retention should use geoPlatform.liveTracking.retentionDays
 *   (default 90, configurable 7–365) when a retention job is added.
 */
const attendanceHeartbeatSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    confidence: { type: Number, default: null, min: 0, max: 100 },
    speed: { type: Number, default: null },
    heading: { type: Number, default: null, min: 0, max: 360 },
    trackingContext: { type: String, trim: true, maxlength: 32, default: null },
    expectedNextPingMs: { type: Number, default: null },
    /** Where the sample was collected on device. */
    source: {
      type: String,
      enum: ['foreground', 'background', 'fetch'],
      required: false,
      default: undefined
    },
    /** Device battery percent at capture time (0–100), optional. */
    battery: { type: Number, required: false, min: 0, max: 100, default: undefined },
    capturedAt: { type: Date, required: true },
    clientUuid: { type: String, trim: true, maxlength: 64, default: null }
  },
  { timestamps: true }
);

attendanceHeartbeatSchema.index({ companyId: 1, userId: 1, capturedAt: -1 });
attendanceHeartbeatSchema.index(
  { companyId: 1, userId: 1, clientUuid: 1 },
  { unique: true, partialFilterExpression: { clientUuid: { $type: 'string' } } }
);

/** Hard TTL floor (90d). Prefer retentionDays for app-level purge when implemented. */
attendanceHeartbeatSchema.index({ companyId: 1, capturedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AttendanceHeartbeat', attendanceHeartbeatSchema);
