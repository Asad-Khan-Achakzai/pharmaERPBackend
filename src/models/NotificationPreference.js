const mongoose = require('mongoose');
const { NOTIFICATION_CATEGORY } = require('../constants/enums');

/**
 * Per-user mute preferences by category.
 * Missing category = enabled (default allow).
 */
const notificationPreferenceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Categories the user has muted (push + optional in-app still created unless muteInApp). */
    mutedCategories: {
      type: [{ type: String, enum: Object.values(NOTIFICATION_CATEGORY) }],
      default: []
    },
    /** When true, muted categories skip in-app create entirely. Default: only skip push. */
    muteInApp: { type: Boolean, default: false },
    pushEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

notificationPreferenceSchema.index({ companyId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
