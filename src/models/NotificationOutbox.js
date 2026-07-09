const mongoose = require('mongoose');

const OUTBOX_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENT: 'sent',
  DEAD: 'dead',
  SKIPPED: 'skipped'
};

const notificationOutboxSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    notificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notification',
      required: true
    },
    status: {
      type: String,
      enum: Object.values(OUTBOX_STATUS),
      default: OUTBOX_STATUS.PENDING,
      index: true
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String, default: null },
    ticketIds: { type: [String], default: [] },
    /** Snapshot used at send time (sanitized title/body + data + badge). */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    processedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
notificationOutboxSchema.index({ notificationId: 1 }, { unique: true });

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
module.exports.OUTBOX_STATUS = OUTBOX_STATUS;
