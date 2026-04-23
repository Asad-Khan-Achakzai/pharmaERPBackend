const mongoose = require('mongoose');
const { ATTENDANCE_STATUS, ATTENDANCE_MARKED_BY } = require('../constants/enums');
const { softDeletePlugin } = require('../plugins/softDelete');

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
    markedBy: {
      type: String,
      enum: Object.values(ATTENDANCE_MARKED_BY),
      default: ATTENDANCE_MARKED_BY.SELF
    },
    notes: { type: String, trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

attendanceSchema.index({ companyId: 1, employeeId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ companyId: 1, date: 1 });

attendanceSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Attendance', attendanceSchema);
