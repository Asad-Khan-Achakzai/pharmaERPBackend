const DeviceSession = require('../models/DeviceSession');
const Notification = require('../models/Notification');
const { PUSH_STATUS } = require('../models/Notification');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getPushBackendStatus, isValidExpoPushToken } = require('../utils/pushDiagnostics');
const { isPermanentPushError } = require('../utils/pushOutboxBackoff');

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

function getExpoClient() {
  if (!ExpoSDK) return null;
  return new ExpoSDK.Expo({ accessToken: env.EXPO_ACCESS_TOKEN });
}

/**
 * Send push to all active device sessions for a user.
 * Returns ticket ids for receipt polling. Never throws for empty tokens.
 */
async function sendToUser({ userId, title, body, data = {}, badge, channelId = 'default' }) {
  if (!isPushConfigured()) {
    logger.warn('push.skipped_not_configured', { userId: String(userId) });
    return { sent: 0, failed: 0, skipped: true, ticketIds: [], permanentFailure: false };
  }

  const expo = getExpoClient();
  if (!expo) {
    return { sent: 0, failed: 0, skipped: true, ticketIds: [], permanentFailure: false };
  }

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
    return { sent: 0, failed: 0, skipped: false, ticketIds: [], permanentFailure: false };
  }

  const messages = tokens.map((to) => {
    const msg = {
      to,
      sound: 'default',
      title: title || 'PharmaERP',
      body: body || '',
      data,
      priority: 'high',
      channelId: channelId || 'default'
    };
    if (typeof badge === 'number' && Number.isFinite(badge) && badge >= 0) {
      msg.badge = Math.floor(badge);
    }
    return msg;
  });

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  let failed = 0;
  const ticketIds = [];
  let permanentFailure = false;
  const deadTokens = new Set();

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i += 1) {
        const ticket = tickets[i];
        const token = chunk[i]?.to;
        if (ticket.status === 'ok') {
          sent += 1;
          if (ticket.id) ticketIds.push(String(ticket.id));
        } else {
          failed += 1;
          const errCode = ticket.details?.error || ticket.message || 'unknown';
          logger.warn('push.ticket_error', {
            userId: String(userId),
            error: errCode,
            message: ticket.message
          });
          if (String(errCode).toLowerCase().includes('devicenotregistered') && token) {
            deadTokens.add(token);
            permanentFailure = true;
          }
        }
      }
    } catch (err) {
      failed += chunk.length;
      logger.error('push.send_failed', { userId: String(userId), err: err.message });
      if (isPermanentPushError(err)) permanentFailure = true;
      throw err;
    }
  }

  if (deadTokens.size) {
    await DeviceSession.updateMany(
      { userId, pushToken: { $in: [...deadTokens] }, revokedAt: null },
      { $set: { pushToken: null } }
    );
    logger.info('push.tokens_pruned_on_ticket', {
      userId: String(userId),
      count: deadTokens.size
    });
  }

  if (sent > 0) {
    logger.info('push.sent', { userId: String(userId), sent, failed, ticketCount: ticketIds.length });
  }

  return { sent, failed, skipped: false, ticketIds, permanentFailure };
}

/**
 * Poll Expo receipts and prune DeviceNotRegistered tokens.
 * @param {string[]} ticketIds
 * @returns {{ delivered: number, failed: number, pruned: number }}
 */
async function processReceipts(ticketIds) {
  if (!ticketIds?.length || !isPushConfigured()) {
    return { delivered: 0, failed: 0, pruned: 0 };
  }
  const expo = getExpoClient();
  if (!expo) return { delivered: 0, failed: 0, pruned: 0 };

  const chunks = expo.chunkPushNotificationReceiptIds(ticketIds);
  let delivered = 0;
  let failed = 0;
  let pruned = 0;
  const deadTokens = [];

  for (const chunk of chunks) {
    let receipts;
    try {
      receipts = await expo.getPushNotificationReceiptsAsync(chunk);
    } catch (err) {
      logger.error('push.receipts_failed', { err: err.message });
      continue;
    }

    for (const [id, receipt] of Object.entries(receipts || {})) {
      if (receipt.status === 'ok') {
        delivered += 1;
        continue;
      }
      failed += 1;
      const errCode = receipt.details?.error || receipt.message || 'unknown';
      logger.warn('push.receipt_error', { ticketId: id, error: errCode });
      if (String(errCode).toLowerCase().includes('devicenotregistered')) {
        // Expo does not always echo the token; we still mark notification failed.
        if (receipt.details?.expoPushToken) {
          deadTokens.push(String(receipt.details.expoPushToken));
        }
      }
    }
  }

  if (deadTokens.length) {
    const result = await DeviceSession.updateMany(
      { pushToken: { $in: deadTokens }, revokedAt: null },
      { $set: { pushToken: null } }
    );
    pruned = result.modifiedCount || 0;
    logger.info('push.tokens_pruned_on_receipt', { pruned, tokens: deadTokens.length });
  }

  return { delivered, failed, pruned };
}

async function markNotificationPushStatus(notificationId, status, errorCode = null) {
  if (!notificationId) return;
  const update = {
    pushStatus: status,
    pushAttemptedAt: new Date()
  };
  if (errorCode) update.pushErrorCode = String(errorCode).slice(0, 200);
  else if (status === PUSH_STATUS.SENT || status === PUSH_STATUS.DELIVERED) {
    update.pushErrorCode = null;
  }
  await Notification.updateOne({ _id: notificationId }, { $set: update });
}

module.exports = {
  sendToUser,
  processReceipts,
  isPushConfigured,
  getPushBackendStatus,
  markNotificationPushStatus,
  isValidExpoPushToken
};
