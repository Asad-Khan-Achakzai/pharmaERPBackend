const authService = require('../services/auth.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  ApiResponse.created(res, result, 'Company registered successfully');
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password, req.ip);
  ApiResponse.success(res, result, 'Login successful');
});

const refreshToken = asyncHandler(async (req, res) => {
  const tokens = await authService.refreshToken(req.body.refreshToken);
  ApiResponse.success(res, tokens, 'Token refreshed');
});

const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.userId, req.jwtAccess);
  ApiResponse.success(res, user);
});

const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.userId, req.body);
  ApiResponse.success(res, null, 'Password changed successfully');
});

const switchCompany = asyncHandler(async (req, res) => {
  const { companyId } = req.body;
  const data = await authService.switchCompany(req.user.userId, companyId);
  ApiResponse.success(res, data, 'Company context updated');
});

module.exports = { register, login, refreshToken, getMe, changePassword, switchCompany };
