const mongoose = require('mongoose');

const geoCacheSchema = new mongoose.Schema(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    api: { type: String, required: true, trim: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

geoCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('GeoCache', geoCacheSchema);
