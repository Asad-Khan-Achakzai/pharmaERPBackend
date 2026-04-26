const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const Company = require('../models/Company');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/enums');
const { generateTokens } = require('./auth.tokens');
const { seedDefaultRolesForCompany } = require('./role.service');
const { formatUserForClient } = require('../utils/authUserPayload');

const register = async ({ companyName, companyEmail, companyPhone, name, email, password }) => {
  const existingCompany = await Company.findOne({ email: companyEmail });
  if (existingCompany) {
    throw new ApiError(409, 'A company with this email already exists');
  }

  const company = await Company.create({
    name: companyName,
    email: companyEmail,
    phone: companyPhone
  });

  const { adminRole } = await seedDefaultRolesForCompany(company._id, {});

  const user = await User.create({
    companyId: company._id,
    name,
    email,
    password,
    role: ROLES.ADMIN,
    roleId: adminRole._id,
    permissions: []
  });

  const tokens = generateTokens(user._id, company._id);
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return { user: (await formatUserForClient(user._id)) || user.toJSON(), company, tokens };
};

const login = async (email, password, ip) => {
  const user = await User.findOne({ email }).select('+password +refreshToken');
  if (!user) {
    throw new ApiError(401, 'Invalid email or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Account is deactivated');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const tokens = generateTokens(user._id, user.companyId);
  user.lastLoginAt = new Date();
  if (ip) user.lastLoginIP = ip;
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return { user: (await formatUserForClient(user._id)) || user.toJSON(), tokens };
};

const refreshToken = async (token) => {
  if (!token) {
    throw new ApiError(401, 'Refresh token required');
  }

  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
  const user = await User.findById(decoded.userId).select('+refreshToken');

  if (!user || user.refreshToken !== token) {
    throw new ApiError(401, 'Invalid refresh token');
  }

  const tokens = generateTokens(user._id, user.companyId);
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return tokens;
};

const getMe = async (userId) => {
  const user = await formatUserForClient(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }
  return user;
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    throw new ApiError(400, 'Current password is incorrect');
  }

  user.password = newPassword;
  await user.save();
};

module.exports = { register, login, refreshToken, getMe, changePassword };
