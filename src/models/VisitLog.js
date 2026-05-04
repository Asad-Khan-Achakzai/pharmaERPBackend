const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

const visitLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    /** Null for unplanned visits */
    planItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanItem', default: null },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Required for doctor visits; optional for non-doctor tasks. */
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    visitTime: { type: Date, default: Date.now },
    checkInTime: { type: Date },
    checkOutTime: { type: Date },
    location: {
      lat: { type: Number },
      lng: { type: Number }
    },
    notes: { type: String, trim: true, maxlength: 2000 },
    orderTaken: { type: Boolean, default: false },
    /** Products discussed during visit (MRep execution). */
    productsDiscussed: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    primaryProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /** Quick quantity (e.g. rep +/-); optional note string still in samplesGiven. */
    samplesQty: { type: Number, min: 0, default: null },
    samplesGiven: { type: String, trim: true, maxlength: 500 },
    followUpDate: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

visitLogSchema.index({ companyId: 1, employeeId: 1, visitTime: -1 });
visitLogSchema.index({ companyId: 1, doctorId: 1, visitTime: -1 });
visitLogSchema.index({ planItemId: 1 }, { sparse: true });

visitLogSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('VisitLog', visitLogSchema);
