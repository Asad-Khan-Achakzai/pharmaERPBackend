const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const OWNERSHIP_EVENT_FIELDS = ['assignedRepId', 'territoryId'];

const doctorOwnershipEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true, index: true },
    field: { type: String, enum: OWNERSHIP_EVENT_FIELDS, required: true },
    fromId: { type: mongoose.Schema.Types.ObjectId, default: null },
    toId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Actor (manager/admin); optional for migrated rows */
    changedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    effectiveAt: { type: Date, default: Date.now, index: true },
    reason: { type: String, trim: true, maxlength: 500, default: null }
  },
  { timestamps: true }
);

doctorOwnershipEventSchema.index({ companyId: 1, doctorId: 1, effectiveAt: -1 });

doctorOwnershipEventSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('DoctorOwnershipEvent', doctorOwnershipEventSchema);
module.exports.OWNERSHIP_EVENT_FIELDS = OWNERSHIP_EVENT_FIELDS;
