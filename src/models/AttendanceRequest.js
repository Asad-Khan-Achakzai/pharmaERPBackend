const mongoose = require('mongoose');
const { ATTENDANCE_REQUEST_TYPE, ATTENDANCE_REQUEST_STATUS } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const decisionSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true },
    comment: { type: String, trim: true, maxlength: 2000 },
    at: { type: Date, default: () => new Date() },
    /** USER = human action; SYSTEM = scheduler/background; POLICY = company rule (SLA, end-of-day). */
    source: { type: String, enum: ['USER', 'SYSTEM', 'POLICY'], default: 'USER' }
  },
  { _id: false }
);

const attendanceRequestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
    type: { type: String, enum: Object.values(ATTENDANCE_REQUEST_TYPE), required: true },
    status: {
      type: String,
      enum: Object.values(ATTENDANCE_REQUEST_STATUS),
      default: ATTENDANCE_REQUEST_STATUS.PENDING
    },
    currentStepIndex: { type: Number, default: 0 },
    /** Snapshot of matrix steps at submission (audit). */
    stepsSnapshot: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    matrixId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalMatrix', default: null },
    currentApproverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** When set, automation / UI can show SLA deadline. */
    slaDueAt: { type: Date, default: null },
    /** Dedup key for last background action (e.g. SLA, EOD_2026-05-09). */
    lastAutoActionKey: { type: String, default: null, trim: true },
    lastAutoActionAt: { type: Date, default: null },
    reason: { type: String, trim: true, maxlength: 2000 },
    /** Requested payload (e.g. corrected times ISO strings). */
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    decisions: { type: [decisionSchema], default: () => [] }
  },
  { timestamps: true }
);

attendanceRequestSchema.index({ companyId: 1, status: 1, currentApproverId: 1 });
attendanceRequestSchema.index({ companyId: 1, requesterId: 1, createdAt: -1 });
attendanceRequestSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('AttendanceRequest', attendanceRequestSchema);
