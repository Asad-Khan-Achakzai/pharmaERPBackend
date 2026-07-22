const mongoose = require('mongoose');

const FANOUT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed'
};

const announcementFanoutSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    announcementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Announcement',
      required: true,
      unique: true
    },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: Object.values(FANOUT_STATUS),
      default: FANOUT_STATUS.PENDING,
      index: true
    },
    cursorUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    enqueuedUsers: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

announcementFanoutSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('AnnouncementFanout', announcementFanoutSchema);
module.exports.FANOUT_STATUS = FANOUT_STATUS;
