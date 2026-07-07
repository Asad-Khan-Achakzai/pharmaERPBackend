const mongoose = require('mongoose');
const { softDeletePlugin } = require('../plugins/softDelete');

/**
 * CP (Call Planning) master — Admin-managed list of check-in points per company.
 * Medical reps select one of these per day when building a weekly plan; the daily
 * check-in distance validation reads the selected CP's coordinates.
 *
 * Coordinates are entered manually (no map integration).
 */
const callPointSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

callPointSchema.index({ companyId: 1, isActive: 1, name: 1 });
callPointSchema.index({ companyId: 1, latitude: 1, longitude: 1 });
/** Name unique per company (case-insensitive), ignoring soft-deleted rows. */
callPointSchema.index(
  { companyId: 1, name: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { isDeleted: { $ne: true } }
  }
);

callPointSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CallPoint', callPointSchema);
