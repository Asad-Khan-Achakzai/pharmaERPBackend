const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const mobileAuthService = require('../services/mobileAuth.service');
const logger = require('../utils/logger');
const { maskPushToken, isValidExpoPushToken } = require('../utils/pushDiagnostics');

const login = asyncHandler(async (req, res) => {
  const { email, password, device } = req.body;
  const data = await mobileAuthService.login({ email, password, device, ip: req.ip });
  ApiResponse.success(res, data, 'Login successful');
});

const registerDevice = asyncHandler(async (req, res) => {
  logger.info('mobile.api.register_device', {
    userId: String(req.user.userId),
    deviceId: req.body?.device?.deviceId || null,
    platform: req.body?.device?.platform || null
  });
  const data = await mobileAuthService.registerDevice({
    user: req.user,
    device: req.body.device
  });
  ApiResponse.success(res, data, 'Device registered');
});

const refresh = asyncHandler(async (req, res) => {
  const tokens = await mobileAuthService.refresh({
    refreshToken: req.body.refreshToken,
    deviceId: req.body.deviceId
  });
  ApiResponse.success(res, tokens, 'Token refreshed');
});

const logout = asyncHandler(async (req, res) => {
  await mobileAuthService.logout({ user: req.user, deviceId: req.body.deviceId });
  ApiResponse.success(res, null, 'Logged out');
});

const listSessions = asyncHandler(async (req, res) => {
  const data = await mobileAuthService.listSessions({ user: req.user });
  ApiResponse.success(res, data);
});

const revokeSession = asyncHandler(async (req, res) => {
  await mobileAuthService.revokeSession({ user: req.user, sessionId: req.params.id });
  ApiResponse.success(res, null, 'Session revoked');
});

const reportPushDiagnostic = asyncHandler(async (req, res) => {
  const data = await mobileAuthService.reportPushDiagnostic({
    user: req.user,
    deviceId: req.body.deviceId,
    platform: req.body.platform,
    appVersion: req.body.appVersion,
    step: req.body.step,
    result: req.body.result,
    detail: req.body.detail,
    errorMessage: req.body.errorMessage,
    executionEnvironment: req.body.executionEnvironment,
    projectIdPresent: req.body.projectIdPresent
  });
  ApiResponse.success(res, data, 'Diagnostic logged');
});

const updatePushToken = asyncHandler(async (req, res) => {
  const pushToken = req.body?.pushToken ? String(req.body.pushToken).trim() : null;
  logger.info('mobile.api.push_token', {
    userId: String(req.user.userId),
    companyId: req.user.companyId ? String(req.user.companyId) : null,
    deviceId: req.body?.deviceId || null,
    tokenProvided: !!pushToken,
    tokenPreview: pushToken ? maskPushToken(pushToken) : null,
    tokenValidExpoFormat: pushToken ? isValidExpoPushToken(pushToken) : false,
    ip: req.ip
  });
  const data = await mobileAuthService.updatePushToken({
    user: req.user,
    deviceId: req.body.deviceId,
    pushToken: req.body.pushToken
  });
  ApiResponse.success(res, data, 'Push token updated');
});

const changePassword = asyncHandler(async (req, res) => {
  await mobileAuthService.changePassword({
    userId: req.user.userId,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword
  });
  ApiResponse.success(res, null, 'Password changed');
});

const switchCompany = asyncHandler(async (req, res) => {
  const data = await mobileAuthService.switchCompany({
    user: req.user,
    companyId: req.body.companyId,
    device: req.body.device
  });
  ApiResponse.success(res, data, 'Company switched');
});

module.exports = {
  login,
  registerDevice,
  refresh,
  logout,
  listSessions,
  revokeSession,
  updatePushToken,
  reportPushDiagnostic,
  changePassword,
  switchCompany
};
