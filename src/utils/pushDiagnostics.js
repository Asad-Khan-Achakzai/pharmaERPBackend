const DeviceSession = require('../models/DeviceSession');
const env = require('../config/env');

let ExpoSDK = null;
try {
  // eslint-disable-next-line global-require
  ExpoSDK = require('expo-server-sdk');
} catch {
  ExpoSDK = null;
}

/** Safe preview for logs — never log full push tokens. */
function maskPushToken(token) {
  if (token == null || token === '') return null;
  const s = String(token).trim();
  if (s.length <= 16) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 22)}…${s.slice(-8)}`;
}

function getPushBackendStatus() {
  const hasAccessToken = !!(env.EXPO_ACCESS_TOKEN && String(env.EXPO_ACCESS_TOKEN).trim());
  return {
    expoSdkLoaded: !!ExpoSDK,
    hasExpoAccessToken: hasAccessToken,
    backendReady: !!(ExpoSDK && hasAccessToken),
    accessTokenLength: hasAccessToken ? String(env.EXPO_ACCESS_TOKEN).trim().length : 0
  };
}

function isValidExpoPushToken(token) {
  if (!ExpoSDK || !token) return false;
  try {
    return ExpoSDK.Expo.isExpoPushToken(String(token));
  } catch {
    return false;
  }
}

/**
 * Summarize device sessions for push troubleshooting (no secrets).
 */
async function summarizeUserPushSessions(userId) {
  const uid = String(userId);
  const [active, withToken, allForUser] = await Promise.all([
    DeviceSession.find({ userId, revokedAt: null })
      .select('deviceId platform brand model appVersion pushToken lastSeenAt createdAt')
      .sort({ lastSeenAt: -1 })
      .lean(),
    DeviceSession.countDocuments({
      userId,
      revokedAt: null,
      pushToken: { $exists: true, $nin: [null, ''] }
    }),
    DeviceSession.countDocuments({ userId })
  ]);

  const sessions = active.map((s) => ({
    deviceId: s.deviceId,
    platform: s.platform,
    brand: s.brand,
    model: s.model,
    appVersion: s.appVersion,
    hasPushToken: !!(s.pushToken && String(s.pushToken).trim()),
    pushTokenPreview: s.pushToken ? maskPushToken(s.pushToken) : null,
    pushTokenValid: s.pushToken ? isValidExpoPushToken(s.pushToken) : false,
    lastSeenAt: s.lastSeenAt,
    createdAt: s.createdAt
  }));

  const validTokenCount = sessions.filter((s) => s.pushTokenValid).length;

  return {
    userId: uid,
    totalSessionsEver: allForUser,
    activeSessionCount: sessions.length,
    activeWithPushTokenField: withToken,
    activeWithValidExpoToken: validTokenCount,
    sessions
  };
}

module.exports = {
  maskPushToken,
  getPushBackendStatus,
  isValidExpoPushToken,
  summarizeUserPushSessions
};
