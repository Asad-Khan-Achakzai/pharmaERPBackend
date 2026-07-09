const asyncHandler = require('../middleware/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const mobileAuthService = require('../services/mobileAuth.service');
const deviceControlService = require('../services/deviceControl.service');

const login = asyncHandler(async (req, res) => {
  const { email, password, device } = req.body;
  const data = await mobileAuthService.login({ email, password, device, ip: req.ip });
  ApiResponse.success(res, data, 'Login successful');
});

const registerDevice = asyncHandler(async (req, res) => {
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

const updatePushToken = asyncHandler(async (req, res) => {
  const data = await mobileAuthService.updatePushToken({
    user: req.user,
    deviceId: req.body.deviceId,
    pushToken: req.body.pushToken,
    headerDeviceId: req.get('X-Device-Id') || req.get('x-device-id')
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

// --- Device change request flow (authed by short-lived device-change token) ---

const requestDeviceChange = asyncHandler(async (req, res) => {
  const data = await deviceControlService.createDeviceChangeRequest({
    userId: req.deviceChange.userId,
    companyId: req.deviceChange.companyId,
    tokenDeviceId: req.deviceChange.deviceId,
    device: req.body.device,
    reason: req.body.reason
  });
  ApiResponse.created(res, data, 'Device change request submitted');
});

const getDeviceChangeRequest = asyncHandler(async (req, res) => {
  const data = await deviceControlService.getMyDeviceChangeRequest({
    userId: req.deviceChange.userId,
    companyId: req.deviceChange.companyId,
    deviceId: req.deviceChange.deviceId
  });
  ApiResponse.success(res, data);
});

const cancelDeviceChange = asyncHandler(async (req, res) => {
  const data = await deviceControlService.cancelDeviceChangeRequest({
    userId: req.deviceChange.userId,
    companyId: req.deviceChange.companyId
  });
  ApiResponse.success(res, data, 'Device change request cancelled');
});

module.exports = {
  login,
  registerDevice,
  refresh,
  logout,
  listSessions,
  revokeSession,
  updatePushToken,
  changePassword,
  switchCompany,
  requestDeviceChange,
  getDeviceChangeRequest,
  cancelDeviceChange
};
