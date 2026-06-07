const mongoose = require('mongoose');

/**
 * Append-only location pings for optional live rep tracking.
 * Latest row per user is used for manager live map; clientUuid supports idempotent replay.
 */
const attendanceHeartbeatSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
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

module.exports = mongoose.model('AttendanceHeartbeat', attendanceHeartbeatSchema);
