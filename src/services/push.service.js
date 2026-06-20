const DeviceSession = require('../models/DeviceSession');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getPushBackendStatus, isValidExpoPushToken } = require('../utils/pushDiagnostics');

let ExpoSDK = null;
try {
  // eslint-disable-next-line global-require
  ExpoSDK = require('expo-server-sdk');
} catch {
  ExpoSDK = null;
}

function isPushConfigured() {
  return getPushBackendStatus().backendReady;
}

/**
 * Send push to all active device sessions for a user. Best-effort; never throws.
 */
async function sendToUser({ userId, title, body, data = {} }) {
  if (!isPushConfigured()) {
    logger.warn('push.skipped_not_configured', { userId: String(userId) });
    return { sent: 0, skipped: true };
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

  const tokens = [
    ...new Set(
      sessions
        .map((s) => String(s.pushToken).trim())
        .filter(Boolean)
        .filter((t) => isValidExpoPushToken(t))
    )
  ];

  if (!tokens.length) {
    logger.warn('push.no_tokens', { userId: String(userId), sessionCount: sessions.length });
    return { sent: 0 };
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
  let failed = 0;

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === 'ok') sent += 1;
        else failed += 1;
      }
    } catch (err) {
      failed += chunk.length;
      logger.error('push.send_failed', { userId: String(userId), err: err.message });
    }
  }

  if (sent > 0) {
    logger.info('push.sent', { userId: String(userId), sent, failed });
  }

  return { sent, failed, skipped: false };
}

module.exports = { sendToUser, isPushConfigured, getPushBackendStatus };
