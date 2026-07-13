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
    /** Meters from verified doctor coordinates when geo-fence evaluated. */
    distanceFromDoctor: { type: Number, default: null },
    geoFenceResult: {
      type: String,
      enum: ['NOT_APPLICABLE', 'INSIDE_RADIUS', 'OUTSIDE_RADIUS'],
      default: 'NOT_APPLICABLE'
    },
    /** Device-reported GPS accuracy (meters) at visit completion. */
    gpsAccuracy: { type: Number, default: null },
    notes: { type: String, trim: true, maxlength: 2000 },
    orderTaken: { type: Boolean, default: false },
    /** Products discussed during visit (MRep execution). */
    productsDiscussed: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    primaryProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /** Quick quantity (e.g. rep +/-); optional note string still in samplesGiven. */
    samplesQty: { type: Number, min: 0, default: null },
    samplesGiven: { type: String, trim: true, maxlength: 500 },
    /** Kits expanded into productsDiscussed during this visit (analytics). */
    presentedKitIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ProductKit' }],
    /** Lightweight presentation session summaries (slide-level events live in ProductEngagementEvent). */
    presentationSessions: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        presentationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductPresentation' },
        presentationVersion: { type: Number, default: null },
        completed: { type: Boolean, default: false },
        startedAt: { type: Date, default: null },
        endedAt: { type: Date, default: null }
      }
    ],
    /**
     * Reserved for future Sample Inventory module — unused until that ships.
     * Keep samplesQty / samplesGiven as the operational fields today.
     */
    sampleLines: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        qty: { type: Number, min: 0 }
      }
    ],
    followUpDate: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

visitLogSchema.index({ companyId: 1, employeeId: 1, visitTime: -1 });
visitLogSchema.index({ companyId: 1, doctorId: 1, visitTime: -1 });
visitLogSchema.index({ planItemId: 1 }, { sparse: true });
visitLogSchema.index(
  { planItemId: 1, employeeId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { isDeleted: { $ne: true } } }
);

visitLogSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('VisitLog', visitLogSchema);
