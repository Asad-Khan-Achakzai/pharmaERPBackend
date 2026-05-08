/**
 * Validates MRep reporting line: MR → ASM → RM → Admin.
 * Skips validation for custom roles (no DEFAULT_* role code).
 */
const mongoose = require('mongoose');
const Role = require('../models/Role');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const {
  ADMIN_ACCESS,
  DEFAULT_ADMIN_CODE,
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE
} = require('../constants/rbac');

const MREP_LADDER_CODES = new Set([
  DEFAULT_MEDICAL_REP_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_RM_CODE,
  DEFAULT_ADMIN_CODE
]);

const HIERARCHY_ERROR = 'Invalid reporting hierarchy for selected role';

/**
 * @param {import('mongoose').Types.ObjectId|string} companyId
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} subordinateRoleId
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} managerId
 */
async function validateReportingHierarchy(companyId, subordinateRoleId, managerId) {
  if (!subordinateRoleId || !mongoose.Types.ObjectId.isValid(subordinateRoleId)) {
    return;
  }
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const subRole = await Role.findOne({ _id: subordinateRoleId, companyId: cid, isDeleted: { $ne: true } })
    .select('code')
    .lean();
  if (!subRole || !subRole.code || !MREP_LADDER_CODES.has(subRole.code)) {
    return;
  }

  if (!managerId) {
    return;
  }

  const mgr = await User.findOne({
    _id: managerId,
    companyId: cid,
    isDeleted: { $ne: true },
    isActive: true
  })
    .populate('roleId', 'code permissions')
    .lean();

  if (!mgr) {
    throw new ApiError(404, 'Manager user not found in this company');
  }

  const mgrCode = mgr.roleId?.code || null;
  const mgrPerms = Array.isArray(mgr.roleId?.permissions) ? mgr.roleId.permissions : [];
  const mgrIsCompanyAdmin = mgrCode === DEFAULT_ADMIN_CODE || mgrPerms.includes(ADMIN_ACCESS);

  if (subRole.code === DEFAULT_MEDICAL_REP_CODE) {
    if (mgrCode !== DEFAULT_ASM_CODE) {
      throw new ApiError(400, HIERARCHY_ERROR);
    }
  } else if (subRole.code === DEFAULT_ASM_CODE) {
    if (mgrCode !== DEFAULT_RM_CODE) {
      throw new ApiError(400, HIERARCHY_ERROR);
    }
  } else if (subRole.code === DEFAULT_RM_CODE) {
    if (!mgrIsCompanyAdmin) {
      throw new ApiError(400, HIERARCHY_ERROR);
    }
  } else if (subRole.code === DEFAULT_ADMIN_CODE) {
    if (!mgrIsCompanyAdmin) {
      throw new ApiError(400, HIERARCHY_ERROR);
    }
  }
}

module.exports = {
  validateReportingHierarchy,
  MREP_LADDER_CODES,
  HIERARCHY_ERROR
};
