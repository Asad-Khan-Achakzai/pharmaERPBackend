const mongoose = require('mongoose');

const repLocationSnapshotSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    confidence: { type: Number, default: null, min: 0, max: 100 },
    speed: { type: Number, default: null },
    heading: { type: Number, default: null, min: 0, max: 360 },
    trackingContext: { type: String, trim: true, maxlength: 32, default: null },
    expectedNextPingMs: { type: Number, default: null },
    uploadedAt: { type: Date, default: Date.now },
    capturedAt: { type: Date, required: true },
    locationSource: { type: String, enum: ['heartbeat', 'checkin'], default: 'heartbeat' }
  },
  { timestamps: true }
);

repLocationSnapshotSchema.index({ companyId: 1, userId: 1 }, { unique: true });
repLocationSnapshotSchema.index({ companyId: 1, capturedAt: -1 });

module.exports = mongoose.model('RepLocationSnapshot', repLocationSnapshotSchema);
