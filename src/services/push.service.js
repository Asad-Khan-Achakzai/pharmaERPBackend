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
  if (!isPushConfigured()) return { sent: 0, skipped: true };

  const Expo = ExpoSDK.Expo;
  const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

  const sessions = await DeviceSession.find({
    userId,
    revokedAt: null,
    pushToken: { $exists: true, $nin: [null, ''] }
  })
    .select('pushToken')
    .lean();

  const tokens = [...new Set(sessions.map((s) => s.pushToken).filter((t) => Expo.isExpoPushToken(t)))];
  if (!tokens.length) return { sent: 0, skipped: false };

  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: title || 'PharmaERP',
    body: body || '',
    data
  }));

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      sent += receipts.filter((r) => r.status === 'ok').length;
    } catch (err) {
      logger.warn('push.send_failed', { userId: String(userId), err: err.message });
    }
  }
  return { sent, skipped: false };
}

module.exports = { sendToUser, isPushConfigured };
