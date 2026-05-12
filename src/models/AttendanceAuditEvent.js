const mongoose = require('mongoose');

/**
 * Append-only attendance audit (does not replace generic AuditLog; finer-grained deltas).
 * actorUserId may be null for system jobs (e.g. auto-checkout batch).
 */
const attendanceAuditEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    source: { type: String, enum: ['USER', 'ADMIN', 'SYSTEM'], required: true },
    action: { type: String, required: true, trim: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    meta: { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

attendanceAuditEventSchema.index({ companyId: 1, createdAt: -1 });
attendanceAuditEventSchema.index({ companyId: 1, attendanceId: 1, createdAt: -1 });
attendanceAuditEventSchema.index({ companyId: 1, 'meta.requestId': 1, createdAt: -1 });

module.exports = mongoose.model('AttendanceAuditEvent', attendanceAuditEventSchema);
