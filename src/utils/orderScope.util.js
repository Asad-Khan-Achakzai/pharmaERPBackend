const mongoose = require('mongoose');
const ApiError = require('./ApiError');
const { ROLES } = require('../constants/enums');
const { userHasPermission, userHasTenantWideAccess } = require('./effectivePermissions');
const {
  DEFAULT_RM_CODE,
  DEFAULT_ASM_CODE,
  DEFAULT_MEDICAL_REP_CODE
} = require('../constants/rbac');
const { resolveSubtreeUserIds } = require('./teamScope');

/**
 * Resolves which `medicalRepId` values the caller may see in order list/detail APIs.
 *
 * @returns {Promise<null>} `null` = company-wide (admin / tenant-wide operators)
 * @returns {Promise<mongoose.Types.ObjectId[]>} scoped rep ids (always includes self for non-admin)
 */
const resolveOrderVisibleMedicalRepIds = async (companyId, reqUser) => {
  if (!reqUser?.userId) return [];

  if (userHasTenantWideAccess(reqUser)) {
    return null;
  }

  const selfId = new mongoose.Types.ObjectId(String(reqUser.userId));

  const isMedicalRep =
    reqUser.role === ROLES.MEDICAL_REP ||
    (reqUser.roleCode && String(reqUser.roleCode) === DEFAULT_MEDICAL_REP_CODE);

  const isManager =
    userHasPermission(reqUser, 'team.viewAllReports') ||
    userHasPermission(reqUser, 'team.view') ||
    (reqUser.roleCode &&
      [DEFAULT_ASM_CODE, DEFAULT_RM_CODE].includes(String(reqUser.roleCode)));

  if (isMedicalRep && !isManager) {
    return [selfId];
  }

  if (isManager) {
    return resolveSubtreeUserIds(companyId, reqUser.userId, {
      includeSelf: true,
      activeOnly: true
    });
  }

  /** Safe default: self only when role is ambiguous but user has orders.view. */
  return [selfId];
};

/**
 * Applies RBAC scope to the Mongo filter for `Order.medicalRepId`.
 * @param {object} filter
 * @param {null|mongoose.Types.ObjectId[]} visibleRepIds
 * @param {string|undefined} queryMedicalRepId
 */
const applyOrderMedicalRepScope = (filter, visibleRepIds, queryMedicalRepId) => {
  if (visibleRepIds === null) {
    if (queryMedicalRepId && mongoose.Types.ObjectId.isValid(queryMedicalRepId)) {
      filter.medicalRepId = new mongoose.Types.ObjectId(queryMedicalRepId);
    }
    return;
  }

  if (!visibleRepIds.length) {
    filter.medicalRepId = { $in: [] };
    return;
  }

  const allowed = new Set(visibleRepIds.map((id) => String(id)));

  if (queryMedicalRepId && mongoose.Types.ObjectId.isValid(queryMedicalRepId)) {
    const qid = String(queryMedicalRepId);
    if (!allowed.has(qid)) {
      throw new ApiError(403, 'You cannot view orders for this medical rep');
    }
    filter.medicalRepId = new mongoose.Types.ObjectId(qid);
    return;
  }

  filter.medicalRepId = { $in: visibleRepIds };
};

/**
 * Ensures a loaded order is visible to the caller. Use 404 to avoid id enumeration.
 */
const assertOrderVisibleToUser = (order, visibleRepIds) => {
  if (visibleRepIds === null || !order) return;
  const repId = order.medicalRepId?._id ?? order.medicalRepId;
  if (!repId) {
    throw new ApiError(404, 'Order not found');
  }
  const ok = visibleRepIds.some((id) => String(id) === String(repId));
  if (!ok) {
    throw new ApiError(404, 'Order not found');
  }
};

module.exports = {
  resolveOrderVisibleMedicalRepIds,
  applyOrderMedicalRepScope,
  assertOrderVisibleToUser
};
