const mongoose = require('mongoose');

/**
 * Cold archive of GPS heartbeats moved out of the hot AttendanceHeartbeat collection
 * after company retentionDays. Kept for long-term compliance / restore.
 * No TTL — purged only by explicit admin policy later.
 */
const attendanceHeartbeatArchiveSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number },
    confidence: { type: Number },
    speed: { type: Number },
    heading: { type: Number },
    trackingContext: { type: String },
    expectedNextPingMs: { type: Number },
    capturedAt: { type: Date, required: true, index: true },
    clientUuid: { type: String },
    source: { type: String, enum: ['foreground', 'background', 'fetch'] },
    battery: { type: Number },
    archivedAt: { type: Date, default: Date.now },
    originalId: { type: mongoose.Schema.Types.ObjectId }
  },
  { timestamps: false, collection: 'attendance_heartbeat_archive' }
);

attendanceHeartbeatArchiveSchema.index({ companyId: 1, userId: 1, capturedAt: -1 });

module.exports = mongoose.model('AttendanceHeartbeatArchive', attendanceHeartbeatArchiveSchema);
