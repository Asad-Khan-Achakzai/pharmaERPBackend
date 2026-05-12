const { DateTime } = require('luxon');
const Company = require('../models/Company');
const WorkShift = require('../models/WorkShift');
const AttendancePolicy = require('../models/AttendancePolicy');
const PolicyAssignment = require('../models/PolicyAssignment');
const businessTime = require('../utils/businessTime');
const ApiError = require('../utils/ApiError');

const selectCompanyFlags =
  'attendanceGovernanceEnabled attendancePoliciesEnabled attendanceApprovalsEnabled strictLateBlocking allowCheckInWhenLate autoRequestOnLateCheckIn timeZone';

/**
 * @param {import('mongoose').Types.ObjectId|string} companyId
 */
const getCompanyFlags = async (companyId) => {
  const c = await Company.findById(companyId).select(selectCompanyFlags).lean();
  if (!c) {
    return {
      attendanceGovernanceEnabled: false,
      attendancePoliciesEnabled: false,
      attendanceApprovalsEnabled: false,
      strictLateBlocking: false,
      allowCheckInWhenLate: false,
      autoRequestOnLateCheckIn: false,
      timeZone: 'UTC'
    };
  }
  return {
    attendanceGovernanceEnabled: Boolean(c.attendanceGovernanceEnabled),
    attendancePoliciesEnabled: Boolean(c.attendancePoliciesEnabled),
    attendanceApprovalsEnabled: Boolean(c.attendanceApprovalsEnabled),
    strictLateBlocking: Boolean(c.strictLateBlocking),
    allowCheckInWhenLate: Boolean(c.allowCheckInWhenLate),
    autoRequestOnLateCheckIn: Boolean(c.autoRequestOnLateCheckIn),
    timeZone: businessTime.getTimeZone(c)
  };
};

/**
 * Effective policy + shift for an employee (policies feature only).
 * @param {object} [options]
 * @param {object} [options.companyFlags] - Result of {@link getCompanyFlags}; avoids one DB round-trip per call when looping (e.g. monitoring summary).
 * @returns {Promise<{ policy: object, shift: object }|null>}
 */
const getEffectivePolicyAndShift = async (companyId, employeeId, asOfDate = new Date(), options = {}) => {
  const flags =
    options.companyFlags != null && typeof options.companyFlags === 'object'
      ? options.companyFlags
      : await getCompanyFlags(companyId);
  if (!flags.attendancePoliciesEnabled) return null;

  const cid = companyId;
  const eid = employeeId;
  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);

  let assignment = await PolicyAssignment.findOne({
    companyId: cid,
    employeeId: eid,
    isDeleted: { $ne: true },
    effectiveFrom: { $lte: asOf },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }]
  })
    .sort({ effectiveFrom: -1 })
    .lean();

  if (!assignment) {
    assignment = await PolicyAssignment.findOne({
      companyId: cid,
      employeeId: null,
      isDeleted: { $ne: true },
      effectiveFrom: { $lte: asOf },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }]
    })
      .sort({ effectiveFrom: -1 })
      .lean();
  }

  let policy = null;
  if (assignment?.policyId) {
    policy = await AttendancePolicy.findOne({ _id: assignment.policyId, companyId: cid, isDeleted: { $ne: true } }).lean();
  }
  if (!policy) {
    policy = await AttendancePolicy.findOne({ companyId: cid, isDefault: true, isDeleted: { $ne: true } }).lean();
  }

  if (!policy) {
    const shiftOnly = await WorkShift.findOne({ companyId: cid, isDefault: true, isDeleted: { $ne: true } }).lean();
    if (!shiftOnly) return null;
    return { policy: null, shift: shiftOnly };
  }

  const shift = await WorkShift.findOne({ _id: policy.workShiftId, companyId: cid, isDeleted: { $ne: true } }).lean();
  if (!shift) return null;
  return { policy, shift };
};

const isOvernightShift = (shift) =>
  Boolean(shift?.shiftEndsNextDay) ||
  (typeof shift?.startMinutes === 'number' &&
    typeof shift?.endMinutes === 'number' &&
    shift.endMinutes < shift.startMinutes);

/**
 * Local instant: after this time, self-service check-in is blocked for the given attendance business date.
 * - Same calendar day shift: closure at businessYmd 00:00 + endMinutes + postShiftCheckInCutoffMinutes.
 * - Overnight shift starting businessYmd: closure at (businessYmd + 1 day) 00:00 + endMinutes + postShiftCheckInCutoffMinutes.
 * @param {string} businessYmd
 * @param {object} shift
 * @param {string} timeZone
 * @returns {import('luxon').DateTime}
 */
const getShiftCheckInCloseDateTime = (businessYmd, shift, timeZone) => {
  const zone = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = String(businessYmd || '').trim();
  const dayStart = DateTime.fromISO(ymd, { zone });
  if (!dayStart.isValid) {
    throw new ApiError(400, 'Invalid business date');
  }
  const overnight = isOvernightShift(shift);
  const rawExtra =
    typeof shift.postShiftCheckInCutoffMinutes === 'number' && shift.postShiftCheckInCutoffMinutes > 0
      ? shift.postShiftCheckInCutoffMinutes
      : 0;
  const extra = Math.min(rawExtra, 720);
  const endM = (typeof shift.endMinutes === 'number' ? shift.endMinutes : 0) + extra;
  if (!overnight) {
    return dayStart.startOf('day').plus({ minutes: endM });
  }
  const endDayStart = dayStart.plus({ days: 1 }).startOf('day');
  return endDayStart.plus({ minutes: endM });
};

/**
 * Whether self-service check-in must be rejected (shift window for this business day has closed).
 * @param {string} businessYmd - attendance anchor date (company calendar), same as check-in uses for `date`
 * @param {object} shift - effective shift
 * @param {string} timeZone
 * @param {import('luxon').DateTime} [nowLuxon] - test hook
 * @returns {boolean}
 */
const isSelfCheckInPastShiftClose = (businessYmd, shift, timeZone, nowLuxon = null) => {
  if (!shift || typeof shift.endMinutes !== 'number') return false;
  const zone = businessTime.requireCompanyIanaZone(timeZone);
  const now = nowLuxon || DateTime.now().setZone(zone);
  const close = getShiftCheckInCloseDateTime(businessYmd, shift, zone);
  return now > close;
};

/**
 * @param {number} nowMinutes - minutes since midnight in business TZ
 * @param {object} shift - work shift doc
 * @returns {number} late minutes (0 if on time within grace)
 */
const computeLateMinutes = (nowMinutes, shift) => {
  if (!shift || typeof shift.startMinutes !== 'number') return 0;
  const grace = typeof shift.graceMinutes === 'number' ? shift.graceMinutes : 0;

  if (!isOvernightShift(shift)) {
    const allowed = shift.startMinutes + grace;
    if (nowMinutes <= allowed) return 0;
    return nowMinutes - allowed;
  }

  let elapsedFromStart;
  if (nowMinutes >= shift.startMinutes) {
    elapsedFromStart = nowMinutes - shift.startMinutes;
  } else {
    elapsedFromStart = 1440 - shift.startMinutes + nowMinutes;
  }

  if (elapsedFromStart <= grace) return 0;
  return elapsedFromStart - grace;
};

/**
 * @param {import('mongoose').Types.ObjectId|string} companyId
 * @param {import('mongoose').Types.ObjectId|string} employeeId
 * @param {string} timeZone - company IANA
 */
const policySummaryForEmployee = async (companyId, employeeId, timeZone, businessYmdOpt = null) => {
  const flags = await getCompanyFlags(companyId);
  if (!flags.attendancePoliciesEnabled) return null;

  const ps = await getEffectivePolicyAndShift(companyId, employeeId);
  if (!ps || !ps.shift) return null;

  const nowMin = businessTime.businessMinutesSinceMidnight(timeZone);
  const lateIfNow = computeLateMinutes(nowMin, ps.shift);

  const fmt = (m) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const overnight = isOvernightShift(ps.shift);
  const ymd = businessYmdOpt || businessTime.nowInBusinessTime(timeZone).toISODate();
  const checkInClosedForShift = isSelfCheckInPastShiftClose(ymd, ps.shift, timeZone);

  return {
    policyId: ps.policy?._id || null,
    policyName: ps.policy?.name || null,
    shiftId: ps.shift._id,
    shiftName: ps.shift.name,
    expectedStartLocal: fmt(ps.shift.startMinutes),
    expectedEndLocal: overnight ? `${fmt(ps.shift.endMinutes)} (+1)` : fmt(ps.shift.endMinutes),
    graceMinutes: ps.shift.graceMinutes,
    shiftEndsNextDay: overnight,
    postShiftCheckInCutoffMinutes: ps.shift.postShiftCheckInCutoffMinutes ?? 0,
    /** If user checked in right now (hint only). */
    hypotheticalLateMinutesNow: lateIfNow,
    /** True when self-service check-in is blocked for this business date (shift end + cutoff passed). */
    checkInClosedForShift
  };
};

module.exports = {
  getCompanyFlags,
  getEffectivePolicyAndShift,
  computeLateMinutes,
  policySummaryForEmployee,
  isOvernightShift,
  getShiftCheckInCloseDateTime,
  isSelfCheckInPastShiftClose
};
