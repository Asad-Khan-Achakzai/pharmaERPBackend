const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/** Work shift template in company business timezone (minutes from local midnight). */
const workShiftSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true },
    /** Minutes from 00:00 business day (e.g. 9*60+30 = 09:30). */
    startMinutes: { type: Number, required: true, min: 0, max: 1439 },
    /** End wall time; if shiftEndsNextDay is true, this is on the calendar day after start (e.g. 02:00 = 120). */
    endMinutes: { type: Number, required: true, min: 0, max: 1439 },
    /**
     * When true, endMinutes is the day after start (cross-midnight shift).
     * Also works if endMinutes < startMinutes without this flag (legacy).
     */
    shiftEndsNextDay: { type: Boolean, default: false },
    graceMinutes: { type: Number, default: 0, min: 0, max: 600 },
    /**
     * Extra minutes after scheduled shift end when self-service check-in stays allowed (0 = ends exactly at shift end).
     * Does not affect start-of-shift grace; applies only to the shift-closure guard for check-in.
     */
    postShiftCheckInCutoffMinutes: { type: Number, default: 0, min: 0, max: 720 },
    minWorkMinutes: { type: Number, default: null, min: 0 },
    halfDayThresholdMinutes: { type: Number, default: null, min: 0 },
    isDefault: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

workShiftSchema.index({ companyId: 1, isDefault: 1 });
workShiftSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('WorkShift', workShiftSchema);
