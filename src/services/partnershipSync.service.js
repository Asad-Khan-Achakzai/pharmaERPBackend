/**
 * Single-pass sync between whole-day Partner (WeeklyPlan.partnerByDay)
 * and Manager Field Day (ManagerFieldDay.medicalRepIds).
 *
 * Never: visit-level co-visit, weeklyPlans.edit bypass via HTTP, or
 * overwriting a different existing Partner (409).
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const ApiError = require('../utils/ApiError');
const { resolveEffectivePermissions, userHasPermission } = require('../utils/effectivePermissions');
const { DEFAULT_ASM_CODE, DEFAULT_RM_CODE } = require('../constants/rbac');
const businessTime = require('../utils/businessTime');
const { CP_DAY_KEYS } = require('../constants/enums');
const { DateTime } = require('luxon');

const idStr = (v) => (v == null ? '' : String(typeof v === 'object' && v._id != null ? v._id : v));

const isFieldDayEligibleManager = async (userId) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return false;
  const user = await User.findById(userId).select('role permissions roleId').lean();
  if (!user) return false;
  let roleDoc = null;
  if (user.roleId) {
    roleDoc = await Role.findById(user.roleId).select('code permissions').lean();
  }
  const permissions = resolveEffectivePermissions(user, roleDoc, process.env.USE_ROLE_BASED_AUTH);
  const reqUser = {
    userId: String(user._id),
    role: user.role,
    roleCode: roleDoc?.code || null,
    permissions
  };
  if (userHasPermission(reqUser, 'managerFieldDays.edit')) return true;
  if (userHasPermission(reqUser, 'team.viewAllReports')) return true;
  if (userHasPermission(reqUser, 'admin.access')) return true;
  const code = String(reqUser.roleCode || '');
  return code === DEFAULT_ASM_CODE || code === DEFAULT_RM_CODE;
};

const applyPartnershipChange = async ({
  source,
  action,
  companyId,
  managerId,
  medicalRepId,
  ymd,
  reqUser,
  timeZone
}) => {
  if (!companyId || !managerId || !medicalRepId || !ymd) return { applied: false };
  if (String(managerId) === String(medicalRepId)) return { applied: false };

  if (source === 'PARTNER') {
    const managerFieldDayService = require('./managerFieldDay.service');
    return managerFieldDayService.applyRepOnFieldDayInternal({
      companyId,
      managerId,
      ymd,
      medicalRepId,
      action,
      reqUser,
      timeZone,
      notify: false
    });
  }

  if (source === 'FIELD_DAY') {
    const weeklyPlanService = require('./weeklyPlan.service');
    return weeklyPlanService.applyDayPartnerForYmdInternal({
      companyId,
      medicalRepId,
      ymd,
      managerId,
      action,
      reqUser,
      timeZone
    });
  }

  return { applied: false };
};

/**
 * Before writing a Field Day that ADDS reps, reject if any added rep already
 * has a different whole-day Partner. No-plan is allowed.
 */
const assertFieldDayAddsAllowed = async (companyId, managerId, addedRepIds, ymd, timeZone) => {
  const weeklyPlanService = require('./weeklyPlan.service');
  const manager = String(managerId);
  for (const repId of addedRepIds || []) {
    const { partnerId } = await weeklyPlanService.currentPartnerForYmd(
      companyId,
      repId,
      ymd,
      timeZone
    );
    if (partnerId && partnerId !== manager) {
      throw new ApiError(409, 'This rep already has a different Partner for that day');
    }
  }
};

const syncFieldDaysForRepDiff = async ({
  companyId,
  managerId,
  ymd,
  addedIds,
  removedIds,
  reqUser,
  timeZone
}) => {
  await assertFieldDayAddsAllowed(companyId, managerId, addedIds, ymd, timeZone);
  for (const medicalRepId of addedIds || []) {
    await applyPartnershipChange({
      source: 'FIELD_DAY',
      action: 'ADD',
      companyId,
      managerId,
      medicalRepId,
      ymd,
      reqUser,
      timeZone
    });
  }
  for (const medicalRepId of removedIds || []) {
    await applyPartnershipChange({
      source: 'FIELD_DAY',
      action: 'REMOVE',
      companyId,
      managerId,
      medicalRepId,
      ymd,
      reqUser,
      timeZone
    });
  }
};

const syncFieldDayFromPartnerChanges = async ({
  companyId,
  plan,
  partnerChangedDays,
  previousPartnerByDay,
  reqUser,
  tz,
  publishAdds = true
}) => {
  const weeklyPlanService = require('./weeklyPlan.service');
  const medicalRepId = idStr(plan.medicalRepId);
  if (!medicalRepId) return;

  for (const [dayKey, rawNext] of Object.entries(partnerChangedDays || {})) {
    if (!CP_DAY_KEYS.includes(dayKey)) continue;
    const nextId = rawNext ? idStr(rawNext) : null;
    const prevId = previousPartnerByDay?.[dayKey] ? idStr(previousPartnerByDay[dayKey]) : null;
    if (nextId === prevId) continue;

    const ymds = weeklyPlanService.ymdsForDayKey(plan, dayKey, tz);
    for (const ymd of ymds) {
      if (prevId && (await isFieldDayEligibleManager(prevId))) {
        await applyPartnershipChange({
          source: 'PARTNER',
          action: 'REMOVE',
          companyId,
          managerId: prevId,
          medicalRepId,
          ymd,
          reqUser,
          timeZone: tz
        });
      }
      if (nextId && (await isFieldDayEligibleManager(nextId))) {
        await applyPartnershipChange({
          source: 'PARTNER',
          action: publishAdds ? 'ADD' : 'REMOVE',
          companyId,
          managerId: nextId,
          medicalRepId,
          ymd,
          reqUser,
          timeZone: tz
        });
      }
    }
  }
};

/**
 * Remove this rep from each manager Partner's Field Day for the plan week.
 * Used while the plan is still pending approval (including leaked earlier writes).
 */
const retractFieldDayForPlan = async ({ companyId, plan, reqUser, tz }) => {
  const weeklyPlanService = require('./weeklyPlan.service');
  const medicalRepId = idStr(plan.medicalRepId);
  if (!medicalRepId) return;
  const partnerByDay = plan.partnerByDay
    ? { ...(plan.partnerByDay.toObject?.() ?? plan.partnerByDay) }
    : {};
  for (const dayKey of CP_DAY_KEYS) {
    const managerId = partnerByDay[dayKey] ? idStr(partnerByDay[dayKey]) : null;
    if (!managerId || !(await isFieldDayEligibleManager(managerId))) continue;
    const ymds = weeklyPlanService.ymdsForDayKey(plan, dayKey, tz);
    for (const ymd of ymds) {
      await applyPartnershipChange({
        source: 'PARTNER',
        action: 'REMOVE',
        companyId,
        managerId,
        medicalRepId,
        ymd,
        reqUser,
        timeZone: tz
      });
    }
  }
};

/** Exported for tests. */
const dayKeyForYmd = (ymd, tz) => {
  const zone = businessTime.requireCompanyIanaZone(tz);
  const dt = DateTime.fromISO(String(ymd), { zone });
  if (!dt.isValid) return null;
  return CP_DAY_KEYS[dt.weekday - 1] || null;
};

module.exports = {
  isFieldDayEligibleManager,
  applyPartnershipChange,
  assertFieldDayAddsAllowed,
  syncFieldDaysForRepDiff,
  syncFieldDayFromPartnerChanges,
  retractFieldDayForPlan,
  dayKeyForYmd
};
