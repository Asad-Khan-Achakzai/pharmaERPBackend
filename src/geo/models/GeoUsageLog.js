const mongoose = require('mongoose');

const geoUsageLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    api: { type: String, required: true, trim: true, maxlength: 64 },
    operation: { type: String, required: true, trim: true, maxlength: 128 },
    units: { type: Number, default: 1, min: 0 },
    costEstimateUsd: { type: Number, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

geoUsageLogSchema.index({ companyId: 1, createdAt: -1 });
geoUsageLogSchema.index({ api: 1, createdAt: -1 });

module.exports = mongoose.model('GeoUsageLog', geoUsageLogSchema);
