const mongoose = require('mongoose');

const territoryBoundarySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    territoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Territory', required: true, index: true },
    geometry: {
      type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
      coordinates: { type: Array, required: true }
    },
    label: { type: String, trim: true, maxlength: 200, default: '' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

territoryBoundarySchema.index({ companyId: 1, territoryId: 1 }, { unique: true });
territoryBoundarySchema.index({ geometry: '2dsphere' });

module.exports = mongoose.model('TerritoryBoundary', territoryBoundarySchema);
