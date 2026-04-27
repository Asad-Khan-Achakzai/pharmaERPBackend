const mongoose = require('mongoose');
const UserCompanyAccess = require('../models/UserCompanyAccess');
const Company = require('../models/Company');
const { ROLES } = require('../constants/enums');
const { USER_TYPES } = require('../constants/enums');
const { effectiveUserType } = require('./jwtAccess');

/**
 * @returns {Promise<string[]>} company ObjectIds as strings
 */
const getPlatformAllowedCompanyIds = async (user) => {
  if (!user) return [];
  if (effectiveUserType(user) !== USER_TYPES.PLATFORM) {
    return [String(user.companyId || user._id)];
  }
  const userId = user._id || user;
  const rows = await UserCompanyAccess.find({ userId, status: 'active' })
    .select('companyId')
    .lean();
  if (rows.length) {
    return rows.map((r) => String(r.companyId));
  }
  if (user.role === ROLES.SUPER_ADMIN) {
    const all = await Company.find({ isDeleted: { $ne: true } })
      .select('_id')
      .lean();
    return all.map((c) => String(c._id));
  }
  return [];
};

const hasAccessToCompany = async (user, companyId) => {
  if (!user || !companyId) return false;
  if (effectiveUserType(user) !== USER_TYPES.PLATFORM) {
    return String(user.companyId) === String(companyId);
  }
  const uid = user._id || user;
  const one = await UserCompanyAccess.findOne({
    userId: uid,
    companyId,
    status: 'active'
  })
    .select('_id')
    .lean();
  if (one) return true;
  if (user.role === ROLES.SUPER_ADMIN) {
    const c = await Company.findById(companyId).lean();
    return Boolean(c && c.isDeleted !== true);
  }
  return false;
};

const toObjectId = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

module.exports = {
  getPlatformAllowedCompanyIds,
  hasAccessToCompany,
  toObjectId
};
