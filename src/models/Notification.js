const mongoose = require('mongoose');
const { NOTIFICATION_KIND } = require('../constants/enums');

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
    link: { type: String, trim: true, maxlength: 500, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

notificationSchema.index({ companyId: 1, userId: 1, createdAt: -1 });
notificationSchema.index({ companyId: 1, userId: 1, readAt: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
