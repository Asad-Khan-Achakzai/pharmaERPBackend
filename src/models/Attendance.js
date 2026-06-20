const mongoose = require('mongoose');
const {
  ATTENDANCE_STATUS,
  ATTENDANCE_MARKED_BY,
  ATTENDANCE_CHECKIN_SOURCE,
  ATTENDANCE_CHECKOUT_SOURCE,
  LATE_CHECKIN_APPROVAL_STATUS,
  ATTENDANCE_LOCATION_STATUS,
  CHECKIN_POLICY_TYPE
} = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

const requiredCheckInLocationSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 200 },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null }
  },
  { _id: false }
);

const resolvedCheckInPolicySchema = new mongoose.Schema(
  {
    type: { type: String, trim: true, maxlength: 64 },
    locationName: { type: String, trim: true, maxlength: 200 },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    radiusMeters: { type: Number, min: 0, default: null }
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Calendar day, stored as UTC midnight for that date */
    date: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(ATTENDANCE_STATUS),
      default: ATTENDANCE_STATUS.PRESENT
    },
    checkInTime: { type: Date },
    checkOutTime: { type: Date },
    /** Provenance for audit (unset = legacy row before governance). */
    checkInSource: {
      type: String,
      enum: Object.values(ATTENDANCE_CHECKIN_SOURCE)
    },
    checkOutSource: {
      type: String,
      enum: Object.values(ATTENDANCE_CHECKOUT_SOURCE)
    },
    lateMinutes: { type: Number, default: null },
    workShiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkShift', default: null },
    policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendancePolicy', default: null },
    /** Open attendance workflow request, if any. */
    activeRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceRequest', default: null },
    /**
     * When strict late blocking is on and rep checks in late: time is stored immediately;
     * manager must approve before check-out and before day counts as present.
     */
    lateCheckInApprovalStatus: {
      type: String,
      enum: Object.values(LATE_CHECKIN_APPROVAL_STATUS),
      default: undefined
    },
    markedBy: {
      type: String,
      enum: Object.values(ATTENDANCE_MARKED_BY),
      default: ATTENDANCE_MARKED_BY.SELF
    },
    notes: { type: String, trim: true, maxlength: 500 },
    /** GPS captured at check-in (mobile offline sync). */
    checkInLat: { type: Number, default: null },
    checkInLng: { type: Number, default: null },
    checkInAccuracy: { type: Number, default: null },
    /** GPS captured at check-out (mobile offline sync). */
    checkOutLat: { type: Number, default: null },
    checkOutLng: { type: Number, default: null },
    checkOutAccuracy: { type: Number, default: null },
    /** V2 check-in policy metadata (additive; unset on legacy rows). */
    attendanceLocationStatus: {
      type: String,
      enum: Object.values(ATTENDANCE_LOCATION_STATUS),
      default: undefined
    },
    distanceFromCheckInPoint: { type: Number, default: null, min: 0 },
    /** Canonical V2 required location (name + coordinates). */
    requiredCheckInLocation: { type: requiredCheckInLocationSchema, default: undefined },
    /** Immutable snapshot at first V2 check-in (never overwritten). */
    resolvedCheckInPolicy: { type: resolvedCheckInPolicySchema, default: undefined },
    /** @deprecated — read compat only; use requiredCheckInLocation / resolvedCheckInPolicy. */
    requiredCheckInLocationName: { type: String, trim: true, maxlength: 200, default: undefined },
    /** @deprecated — read compat only; use resolvedCheckInPolicy.type. */
    resolvedCheckInPolicyType: {
      type: String,
      enum: Object.values(CHECKIN_POLICY_TYPE),
      default: undefined
    }
  },
  { timestamps: true }
);

attendanceSchema.index({ companyId: 1, employeeId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ companyId: 1, date: 1 });
attendanceSchema.index({ companyId: 1, attendanceLocationStatus: 1, createdAt: -1 });
attendanceSchema.index({ companyId: 1, createdAt: -1 });

attendanceSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Attendance', attendanceSchema);
