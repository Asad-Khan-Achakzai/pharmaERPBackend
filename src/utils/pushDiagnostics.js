const env = require('../config/env');

let ExpoSDK = null;
try {
  // eslint-disable-next-line global-require
  ExpoSDK = require('expo-server-sdk');
} catch {
  ExpoSDK = null;
}

function getPushBackendStatus() {
  const hasAccessToken = !!(env.EXPO_ACCESS_TOKEN && String(env.EXPO_ACCESS_TOKEN).trim());
  return {
    expoSdkLoaded: !!ExpoSDK,
    hasExpoAccessToken: hasAccessToken,
    backendReady: !!(ExpoSDK && hasAccessToken)
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

module.exports = { getPushBackendStatus, isValidExpoPushToken };
