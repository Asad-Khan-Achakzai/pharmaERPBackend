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
const resolveRoleCode = (reqUser) => {
  if (reqUser?.roleCode != null && String(reqUser.roleCode) !== '') {
    return String(reqUser.roleCode);
  }
  if (reqUser?.resolvedRole?.code != null && String(reqUser.resolvedRole.code) !== '') {
    return String(reqUser.resolvedRole.code);
  }
  return null;
};

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

  const roleCode = resolveRoleCode(reqUser);

  const canSeeTeam =
    userHasPermission(reqUser, 'attendance.viewTeam') ||
    userHasPermission(reqUser, 'attendance.approve.direct') ||
    userHasPermission(reqUser, 'attendance.approve.escalated') ||
    userHasPermission(reqUser, 'attendance.approve') ||
    userHasPermission(reqUser, 'attendance.viewEscalations') ||
    userHasPermission(reqUser, 'attendance.governance.view');

  if (canSeeTeam) {
    /** RM and RM-like roles: full reporting subtree (includes ASMs + MRs below). */
    if (roleCode === DEFAULT_RM_CODE || userHasPermission(reqUser, 'team.viewAllReports')) {
      return resolveSubtreeUserIds(companyId, reqUser.userId, { includeSelf: true, activeOnly: true });
    }

    /** ASM: direct reports + self. */
    if (roleCode === DEFAULT_ASM_CODE) {
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

    /** Custom manager roles: direct reports + self. */
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
   * Field rep — self only. Legacy `user.role === MEDICAL_REP` is ignored when the user has
   * manager attendance permissions (common when roleId was upgraded but legacy role was not).
   */
  if (roleCode === DEFAULT_MEDICAL_REP_CODE || reqUser.role === ROLES.MEDICAL_REP) {
    return [new mongoose.Types.ObjectId(String(reqUser.userId))];
  }

  return [new mongoose.Types.ObjectId(String(reqUser.userId))];
};

module.exports = { resolveAttendanceVisibleUserIds };
