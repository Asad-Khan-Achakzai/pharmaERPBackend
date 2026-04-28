const mongoose = require('mongoose');
const Role = require('../models/Role');
const { ROLES } = require('../constants/enums');
const { ensureDefaultRolesForCompany } = require('../services/role.service');
const { DEFAULT_ADMIN_CODE, DEFAULT_MEDICAL_REP_CODE } = require('../constants/rbac');

/**
 * Load Role for RBAC in a tenant company. `user.roleId` points at a document scoped to
 * the user's home company; when the active tenant differs (platform user), that `_id` does
 * not exist under the other `companyId` — resolve the equivalent role in the target tenant
 * by stable `code` (DEFAULT_ADMIN, etc.).
 *
 * @param {object} userDoc - lean User with roleId, companyId, role
 * @param {import('mongoose').Types.ObjectId|string} tenantCompanyId - active company for permissions
 * @returns {Promise<object|null>}
 */
const resolveRoleDocForTenant = async (userDoc, tenantCompanyId) => {
  if (!userDoc?.roleId || !tenantCompanyId) return null;

  const tid =
    tenantCompanyId instanceof mongoose.Types.ObjectId
      ? tenantCompanyId
      : new mongoose.Types.ObjectId(String(tenantCompanyId));
  const homeId = userDoc.companyId?._id || userDoc.companyId;
  if (!homeId) return null;

  const homeOid = homeId instanceof mongoose.Types.ObjectId ? homeId : new mongoose.Types.ObjectId(String(homeId));
  if (String(homeOid) === String(tid)) {
    return Role.findOne({
      _id: userDoc.roleId._id || userDoc.roleId,
      companyId: tid,
      isDeleted: { $ne: true }
    }).lean();
  }

  const rid = userDoc.roleId._id || userDoc.roleId;
  const homeRole = await Role.findById(rid).select('code name').lean();
  if (!homeRole) return null;

  try {
    await ensureDefaultRolesForCompany(tid);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[resolveRoleDocForTenant] ensureDefaultRolesForCompany failed', err && err.message);
  }

  let code = homeRole.code;
  if (!code) {
    if (userDoc.role === ROLES.ADMIN) code = DEFAULT_ADMIN_CODE;
    else if (userDoc.role === ROLES.MEDICAL_REP) code = DEFAULT_MEDICAL_REP_CODE;
  }
  if (!code) return null;

  return Role.findOne({
    companyId: tid,
    code,
    isDeleted: { $ne: true }
  }).lean();
};

module.exports = { resolveRoleDocForTenant };
