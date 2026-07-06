const mongoose = require('mongoose');

const repLocationSnapshotSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    capturedAt: { type: Date, required: true },
    locationSource: { type: String, enum: ['heartbeat', 'checkin'], default: 'heartbeat' }
  },
  { timestamps: true }
);

repLocationSnapshotSchema.index({ companyId: 1, userId: 1 }, { unique: true });
repLocationSnapshotSchema.index({ companyId: 1, capturedAt: -1 });

module.exports = mongoose.model('RepLocationSnapshot', repLocationSnapshotSchema);
