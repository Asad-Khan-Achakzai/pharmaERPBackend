const jwt = require('jsonwebtoken');
const env = require('../config/env');

const generateTokens = (userId, companyId) => {
  const accessToken = jwt.sign({ userId, companyId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY
  });
  const refreshToken = jwt.sign({ userId, companyId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY
  });
  return { accessToken, refreshToken };
};

module.exports = { generateTokens };
