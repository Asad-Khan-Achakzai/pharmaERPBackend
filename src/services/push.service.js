const DeviceSession = require('../models/DeviceSession');
const env = require('../config/env');
const logger = require('../utils/logger');
const {
  getPushBackendStatus,
  isValidExpoPushToken,
  maskPushToken,
  summarizeUserPushSessions
} = require('../utils/pushDiagnostics');

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
async function sendToUser({ userId, title, body, data = {}, context = {} }) {
  const uid = String(userId);
  const dispatchId = context.notificationId || context.dispatchId || null;

  logger.info('push.send_start', {
    dispatchId,
    userId: uid,
    title: title || 'PharmaERP',
    kind: context.kind || data.kind || null,
    source: context.source || 'notification'
  });

  const backend = getPushBackendStatus();
  if (!backend.backendReady) {
    logger.warn('push.send_aborted_backend_not_ready', {
      dispatchId,
      userId: uid,
      ...backend,
      fix:
        !backend.expoSdkLoaded
          ? 'Install expo-server-sdk on backend'
          : 'Set EXPO_ACCESS_TOKEN on Render (Expo → Account → Access tokens) and redeploy'
    });
    return { sent: 0, skipped: true, reason: 'not_configured', backend };
  }

  const Expo = ExpoSDK.Expo;
  const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

  const sessionSummary = await summarizeUserPushSessions(userId);
  const rawSessions = await DeviceSession.find({
    userId,
    revokedAt: null,
    pushToken: { $exists: true, $nin: [null, ''] }
  })
    .select('pushToken deviceId platform')
    .lean();

  const rawTokens = [...new Set(rawSessions.map((s) => String(s.pushToken).trim()).filter(Boolean))];
  const validTokens = rawTokens.filter((t) => isValidExpoPushToken(t));
  const invalidTokens = rawTokens.filter((t) => !isValidExpoPushToken(t));

  if (!validTokens.length) {
    logger.warn('push.send_aborted_no_valid_tokens', {
      dispatchId,
      userId: uid,
      ...sessionSummary,
      rawPushTokenCount: rawTokens.length,
      invalidPushTokenCount: invalidTokens.length,
      invalidTokenPreviews: invalidTokens.slice(0, 3).map(maskPushToken),
      diagnosis:
        sessionSummary.activeSessionCount === 0
          ? 'STEP_1_FAIL: No active DeviceSession — user must log in on the EAS APK first'
          : sessionSummary.activeWithPushTokenField === 0
            ? 'STEP_2_FAIL: Device logged in but POST /auth/mobile/push-token never saved a token — check FCM in EAS, notification permission on phone, and [push] logs on device'
            : invalidTokens.length > 0
              ? 'STEP_3_FAIL: pushToken stored but invalid format — re-login after fixing FCM/build'
              : 'STEP_2_FAIL: Unknown — no push token on active sessions'
    });
    return {
      sent: 0,
      skipped: false,
      reason: 'no_valid_tokens',
      sessionSummary
    };
  }

  if (invalidTokens.length) {
    logger.warn('push.invalid_tokens_ignored', {
      dispatchId,
      userId: uid,
      count: invalidTokens.length,
      previews: invalidTokens.slice(0, 3).map(maskPushToken)
    });
  }

  const messages = validTokens.map((to) => ({
    to,
    sound: 'default',
    title: title || 'PharmaERP',
    body: body || '',
    data,
    priority: 'high',
    channelId: 'default'
  }));

  logger.info('push.expo_send_attempt', {
    dispatchId,
    userId: uid,
    validTokenCount: validTokens.length,
    tokenPreviews: validTokens.map(maskPushToken)
  });

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  let failed = 0;
  const receiptErrors = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === 'ok') {
          sent += 1;
        } else {
          failed += 1;
          receiptErrors.push({
            message: receipt.message,
            details: receipt.details,
            tokenPreview: receipt.details?.expoPushToken
              ? maskPushToken(receipt.details.expoPushToken)
              : undefined
          });
        }
      }
    } catch (err) {
      failed += chunk.length;
      logger.error('push.expo_chunk_failed', {
        dispatchId,
        userId: uid,
        err: err.message,
        chunkSize: chunk.length
      });
    }
  }

  if (receiptErrors.length) {
    logger.warn('push.expo_receipt_errors', {
      dispatchId,
      userId: uid,
      errorCount: receiptErrors.length,
      errors: receiptErrors.slice(0, 5)
    });
  }

  if (sent > 0) {
    logger.info('push.send_success', {
      dispatchId,
      userId: uid,
      sent,
      failed,
      validTokenCount: validTokens.length
    });
  } else {
    logger.error('push.send_failed_all_receipts', {
      dispatchId,
      userId: uid,
      failed,
      validTokenCount: validTokens.length,
      receiptErrors: receiptErrors.slice(0, 5),
      fix: 'Check Expo push receipt errors — token may be expired; user should re-login. Verify EXPO_ACCESS_TOKEN matches your Expo project.'
    });
  }

  return { sent, failed, skipped: false, validTokenCount: validTokens.length };
}

module.exports = { sendToUser, isPushConfigured, getPushBackendStatus };
