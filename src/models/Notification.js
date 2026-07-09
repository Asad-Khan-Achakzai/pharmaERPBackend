const mongoose = require('mongoose');
const { NOTIFICATION_KIND } = require('../constants/enums');

const PUSH_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

const READ_SOURCE = {
  PUSH_TAP: 'push_tap',
  IN_APP: 'in_app',
  OTHER: 'other'
};

const notificationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 2000, default: '' },
    kind: {
      type: String,
      enum: Object.values(NOTIFICATION_KIND),
      default: NOTIFICATION_KIND.GENERAL
    },
    readAt: { type: Date, default: null },
    /** Set when marked read: push_tap | in_app | other */
    readSource: { type: String, default: null },
    link: { type: String, trim: true, maxlength: 500, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Stable idempotency key; unique per (companyId, userId) when set. */
    dedupeKey: { type: String, trim: true, maxlength: 200, default: null },
    pushStatus: {
      type: String,
      enum: Object.values(PUSH_STATUS),
      default: PUSH_STATUS.PENDING
    },
    pushAttemptedAt: { type: Date, default: null },
    pushErrorCode: { type: String, default: null }
  },
  { timestamps: true }
);

notificationSchema.index({ companyId: 1, userId: 1, createdAt: -1 });
notificationSchema.index({ companyId: 1, userId: 1, readAt: 1 });
notificationSchema.index(
  { companyId: 1, userId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string' } }
  }
);

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.PUSH_STATUS = PUSH_STATUS;
module.exports.READ_SOURCE = READ_SOURCE;
