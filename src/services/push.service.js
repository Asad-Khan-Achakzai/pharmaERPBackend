const DeviceSession = require('../models/DeviceSession');
const env = require('../config/env');
const logger = require('../utils/logger');

let ExpoSDK = null;
try {
  // Optional dependency — push is no-op when package or token is missing.
  // eslint-disable-next-line global-require
  ExpoSDK = require('expo-server-sdk');
} catch {
  ExpoSDK = null;
}

function isPushConfigured() {
  return !!(ExpoSDK && env.EXPO_ACCESS_TOKEN);
}

/**
 * Send push to all active device sessions for a user. Best-effort; never throws.
 */
async function sendToUser({ userId, title, body, data = {} }) {
  if (!isPushConfigured()) {
    logger.warn('push.skipped_not_configured', {
      userId: String(userId),
      hint: 'Set EXPO_ACCESS_TOKEN on the backend (Expo account → Access tokens)'
    });
    return { sent: 0, skipped: true, reason: 'not_configured' };
  }

  const Expo = ExpoSDK.Expo;
  const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

  const sessions = await DeviceSession.find({
    userId,
    revokedAt: null,
    pushToken: { $exists: true, $nin: [null, ''] }
  })
    .select('pushToken')
    .lean();

  const activeSessions = await DeviceSession.countDocuments({ userId, revokedAt: null });

  const tokens = [...new Set(sessions.map((s) => s.pushToken).filter((t) => Expo.isExpoPushToken(t)))];
  if (!tokens.length) {
    logger.info('push.no_tokens', {
      userId: String(userId),
      sessionCount: sessions.length,
      activeSessions,
      hint:
        'Manager must log in on the EAS APK, allow notifications when prompted, and see [push] token registered in device logs'
    });
    return { sent: 0, skipped: false, reason: 'no_tokens' };
  }

  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: title || 'PharmaERP',
    body: body || '',
    data,
    priority: 'high',
    channelId: 'default'
  }));

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      const ok = receipts.filter((r) => r.status === 'ok').length;
      const errors = receipts.filter((r) => r.status === 'error');
      sent += ok;
      if (errors.length) {
        logger.warn('push.receipt_errors', {
          userId: String(userId),
          errors: errors.map((e) => ({ message: e.message, details: e.details }))
        });
      }
    } catch (err) {
      logger.warn('push.send_failed', { userId: String(userId), err: err.message });
    }
  }
  if (sent > 0) {
    logger.info('push.sent', { userId: String(userId), sent, tokenCount: tokens.length });
  }
  return { sent, skipped: false };
}

module.exports = { sendToUser, isPushConfigured };
