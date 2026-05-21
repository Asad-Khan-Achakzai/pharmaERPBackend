const mongoose = require('mongoose');

/**
 * Mobile device session. Mobile clients keep their own refreshToken per device,
 * decoupled from the legacy `User.refreshToken` (which still serves the web app).
 * Web sessions are unaffected when this collection is empty.
 *
 * Soft-delete is intentionally NOT enabled: revocation is represented by
 * setting `revokedAt`. The `lookup by refreshTokenHash + revokedAt: null`
 * pattern is the hot path.
 */
const deviceSessionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    /** Stable identifier minted on first launch (uuid v4) and stored in SecureStore. */
    deviceId: { type: String, required: true, trim: true, index: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], required: true },
    brand: { type: String, trim: true },
    model: { type: String, trim: true },
    osVersion: { type: String, trim: true },
    appVersion: { type: String, trim: true },
    /** SHA-256 hash of the issued refresh token. The raw token never lands in Mongo. */
    refreshTokenHash: { type: String, required: true, index: true },
    /** Expo push token; nullable until the device opts into notifications. */
    pushToken: { type: String, trim: true, default: null },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    /** Free-form reason ("USER_LOGOUT", "ADMIN_REVOKE", "TOKEN_REUSE", ...) */
    revokedReason: { type: String, default: null }
  },
  { timestamps: true }
);

deviceSessionSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
deviceSessionSchema.index({ refreshTokenHash: 1, revokedAt: 1 });

module.exports = mongoose.model('DeviceSession', deviceSessionSchema);
