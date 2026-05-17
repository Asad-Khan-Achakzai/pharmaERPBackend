const mongoose = require('mongoose');
const User = require('../models/User');
const { ROLES } = require('../constants/enums');
const { userHasPermission, userHasTenantWideAccess } = require('./effectivePermissions');
const { DEFAULT_RM_CODE, DEFAULT_ASM_CODE, DEFAULT_MEDICAL_REP_CODE } = require('../constants/rbac');
const { resolveSubtreeUserIds } = require('./teamScope');

/**
 * Resolves which employee ObjectIds the caller may see in attendance team views,
 * reports, and exception summaries. Multi-tenant safe: always scoped by companyId.
 *
 * @param {string} companyId
 * @param {object} reqUser - req.user after companyScope (needs userId, permissions, roleCode, role)
 * @returns {Promise<mongoose.Types.ObjectId[]>}
 */
const resolveAttendanceVisibleUserIds = async (companyId, reqUser) => {
  if (!reqUser?.userId) return [];

  if (userHasTenantWideAccess(reqUser) || userHasPermission(reqUser, 'attendance.viewCompany')) {
    const rows = await User.find({
      companyId,
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    return rows.map((r) => r._id);
  }

  /** Individual contributors (MR / rep) — self only. */
  if (
    reqUser.role === ROLES.MEDICAL_REP ||
    (reqUser.roleCode && String(reqUser.roleCode) === DEFAULT_MEDICAL_REP_CODE)
  ) {
    return [new mongoose.Types.ObjectId(String(reqUser.userId))];
  }

  const canSeeTeam =
    userHasPermission(reqUser, 'attendance.viewTeam') ||
    userHasPermission(reqUser, 'attendance.approve.direct') ||
    userHasPermission(reqUser, 'attendance.approve.escalated') ||
    userHasPermission(reqUser, 'attendance.approve') ||
    userHasPermission(reqUser, 'attendance.viewEscalations') ||
    userHasPermission(reqUser, 'attendance.governance.view');

  if (!canSeeTeam) {
    return [new mongoose.Types.ObjectId(String(reqUser.userId))];
  }

  /** Regional / multi-level hierarchy — full reporting subtree (RM and RM-like roles). */
  if (reqUser.roleCode && String(reqUser.roleCode) === DEFAULT_RM_CODE) {
    return resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: true, activeOnly: true });
  }

  /** ASM: direct reports + self (operational field manager scope). */
  if (reqUser.roleCode && String(reqUser.roleCode) === DEFAULT_ASM_CODE) {
    const direct = await User.find({
      companyId,
      managerId: reqUser.userId,
      isActive: true,
      isDeleted: { $ne: true }
    })
      .select('_id')
      .lean();
    const set = new Set(direct.map((d) => String(d._id)));
    set.add(String(reqUser.userId));
    return Array.from(set, (id) => new mongoose.Types.ObjectId(id));
  }

  /**
   * Custom roles: subtree when team.viewAllReports is granted (typical RM-like supervisor);
   * otherwise direct reports + self.
   */
  if ((reqUser.permissions || []).includes('team.viewAllReports')) {
    return resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: true, activeOnly: true });
  }

  const direct = await User.find({
    companyId,
    managerId: reqUser.userId,
    isActive: true,
    isDeleted: { $ne: true }
  })
    .select('_id')
    .lean();
  const set = new Set(direct.map((d) => String(d._id)));
  set.add(String(reqUser.userId));
  return Array.from(set, (id) => new mongoose.Types.ObjectId(id));
};

module.exports = { resolveAttendanceVisibleUserIds };
