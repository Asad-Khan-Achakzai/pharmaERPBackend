/**
 * Calendar aggregation engine (READ-ONLY).
 *
 * Single source of truth for the web Calendar Module. It centralises:
 *   - scope resolution      (who can see what — mirrors order/weekly-plan RBAC)
 *   - bulk data loading     (one query per source — never per-item loops)
 *   - event transformation  (one normaliser for every event type)
 *   - deterministic resolution of overlapping/derived states
 *   - event classification  (POINT / DERIVED / RANGE)
 *   - KPI computation       (one logic source, consistent across all views)
 *
 * It does NOT mutate any business data and introduces no new business module.
 * Existing entities (PlanItem, Attendance) are read as-is.
 *
 * ── Deterministic resolution rules ────────────────────────────────────────────
 *  1. PlanItem.status is the authoritative state of a planned activity:
 *       PENDING  → Planned   (POINT)
 *       VISITED  → Completed (POINT)   — VisitLog is the detail behind VISITED and
 *                                        is represented via PlanItem.actualVisitTime,
 *                                        never rendered separately (no double count).
 *       MISSED   → Missed    (POINT)   — set by the existing EOD job; read-only here.
 *  2. Attendance is the day context (DERIVED). It is orthogonal to plan items —
 *     it never overrides them and is never merged into the same entry.
 *  3. Different classes never collapse into one entry; precedence is therefore by
 *     class (POINT > DERIVED) for interaction only, not for data merging.
 */
const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const Attendance = require('../models/Attendance');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const {
  resolveOrderVisibleMedicalRepIds
} = require('../utils/orderScope.util');
const { userHasPermission, userHasTenantWideAccess } = require('../utils/effectivePermissions');
const {
  PLAN_ITEM_STATUS,
  PLAN_ITEM_TYPE,
  LATE_CHECKIN_APPROVAL_STATUS,
  ATTENDANCE_STATUS
} = require('../constants/enums');

const CATEGORY = {
  PLANNED: 'PLANNED',
  COMPLETED: 'COMPLETED',
  MISSED: 'MISSED',
  ATTENDANCE: 'ATTENDANCE'
};

const EVENT_CLASS = {
  POINT: 'POINT',
  DERIVED: 'DERIVED'
};

const idStr = (v) => {
  if (v == null) return undefined;
  if (typeof v === 'object' && v._id != null) return String(v._id);
  return String(v);
};

const refName = (ref) => {
  if (ref && typeof ref === 'object') return { id: idStr(ref), name: ref.name };
  if (ref) return { id: String(ref) };
  return {};
};

const ymdOf = (instant, tz) => businessTime.businessDayKeyFromUtcInstant(instant, tz);
const hmOf = (instant, tz) => (instant ? businessTime.formatHmBusiness(instant, tz) : null);

/**
 * Resolve the caller's *base* scope (before any rep narrowing) for the request.
 * Returns `null` for tenant-wide (admin) access, otherwise an array of ObjectIds.
 * Honours the same RBAC as orders/weekly-plans (single consistent rule — req. 5).
 */
const resolveBaseScope = async (companyId, reqUser, scope) => {
  if (scope === 'team' || scope === 'org') {
    if (!userHasTenantWideAccess(reqUser) && !userHasPermission(reqUser, 'team.viewAllReports')) {
      throw new ApiError(403, 'Team scope requires the team.viewAllReports permission');
    }
    return resolveOrderVisibleMedicalRepIds(companyId, reqUser); // null | ObjectId[]
  }
  return [new mongoose.Types.ObjectId(String(reqUser.userId))]; // personal calendar
};

/**
 * Narrow a base scope to the manager-requested rep ids (must stay within base).
 * Empty request → unchanged base scope.
 */
const narrowByRequested = (baseScope, requestedRepIds) => {
  const requested = (requestedRepIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!requested.length) return baseScope;
  if (baseScope === null) return requested; // admin: any requested reps
  const allowed = new Set(baseScope.map((id) => String(id)));
  const narrowed = requested.filter((id) => allowed.has(String(id)));
  return narrowed.length ? narrowed : baseScope;
};

/**
 * Rep directory for the team filter, derived from the *base* scope so the picker
 * stays complete even when a subset of reps is selected. One light distinct pass.
 */
const buildRepDirectory = async (companyId, baseScope, range) => {
  const match = { companyId, date: range, isDeleted: { $ne: true } };
  if (baseScope) match.employeeId = { $in: baseScope };
  const ids = await PlanItem.distinct('employeeId', match);
  if (!ids.length) return [];
  const User = mongoose.model('User');
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  return users
    .map((u) => ({ id: String(u._id), name: u.name || String(u._id) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

/* ── Transformers (the ONLY place events are shaped) ────────────────────────── */

const planItemToEvent = (item, tz, withRepLabel) => {
  const ymd = ymdOf(item.date, tz);
  const status = String(item.status || PLAN_ITEM_STATUS.PENDING).toUpperCase();

  let category = CATEGORY.PLANNED;
  let statusLabel = 'Planned';
  if (status === PLAN_ITEM_STATUS.VISITED) {
    category = CATEGORY.COMPLETED;
    statusLabel = 'Completed';
  } else if (status === PLAN_ITEM_STATUS.MISSED) {
    category = CATEGORY.MISSED;
    statusLabel = 'Missed';
  }

  const isDoctor = item.type === PLAN_ITEM_TYPE.DOCTOR_VISIT;
  const doctor = item.doctorId && typeof item.doctorId === 'object' ? item.doctorId : null;
  const rep = refName(item.employeeId);

  let base = isDoctor
    ? doctor && doctor.name
      ? `Dr. ${doctor.name}`
      : 'Doctor visit'
    : (item.title && String(item.title).trim()) || 'Field task';
  if (item.isUnplanned) base = `${base} (unplanned)`;
  const title = withRepLabel && rep.name ? `${base} · ${rep.name}` : base;

  const subtitleParts = [];
  if (rep.name) subtitleParts.push(rep.name);
  if (doctor && doctor.locationName) subtitleParts.push(doctor.locationName);
  if (doctor && doctor.city) subtitleParts.push(doctor.city);

  const details = [
    { label: 'Type', value: isDoctor ? 'Doctor visit' : 'Field task' },
    { label: 'Status', value: statusLabel }
  ];
  if (rep.name) details.push({ label: 'Rep', value: rep.name });
  if (item.plannedTime) details.push({ label: 'Planned time', value: String(item.plannedTime) });
  const actual = hmOf(item.actualVisitTime, tz);
  if (actual) details.push({ label: 'Completed at', value: actual });
  if (item.notes) details.push({ label: 'Notes', value: String(item.notes) });

  return {
    id: `PLAN_ITEM:${idStr(item._id)}`,
    title,
    start: ymd,
    allDay: true,
    extendedProps: {
      category,
      eventClass: EVENT_CLASS.POINT,
      sourceType: 'PLAN_ITEM',
      status,
      statusLabel,
      subtitle: subtitleParts.join(' · ') || undefined,
      deepLink: item.weeklyPlanId ? `/weekly-plans/${idStr(item.weeklyPlanId)}` : '/weekly-plans',
      repId: rep.id,
      repName: rep.name,
      details
    }
  };
};

const attendanceStatusLabel = (rec) => {
  const status = String(rec.status || '').toUpperCase();
  if (status === ATTENDANCE_STATUS.PRESENT) {
    if (rec.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) return 'Present (late — pending)';
    if (rec.lateMinutes && rec.lateMinutes > 0) return 'Present (late)';
    return 'Present';
  }
  if (status === ATTENDANCE_STATUS.HALF_DAY) return 'Half day';
  if (status === ATTENDANCE_STATUS.ABSENT) return 'Absent';
  if (status === ATTENDANCE_STATUS.LEAVE) return 'Leave';
  return status || 'Attendance';
};

const attendanceToEvent = (rec, tz) => {
  const ymd = ymdOf(rec.date, tz);
  const statusLabel = attendanceStatusLabel(rec);
  const checkIn = hmOf(rec.checkInTime, tz);
  const checkOut = hmOf(rec.checkOutTime, tz);

  const details = [{ label: 'Status', value: statusLabel }];
  if (checkIn) details.push({ label: 'Check-in', value: checkIn });
  if (checkOut) details.push({ label: 'Check-out', value: checkOut });
  if (rec.lateMinutes && rec.lateMinutes > 0) details.push({ label: 'Late by', value: `${rec.lateMinutes} min` });

  const subtitle = [checkIn ? `In ${checkIn}` : '', checkOut ? `Out ${checkOut}` : '']
    .filter(Boolean)
    .join(' · ');

  return {
    id: `ATTENDANCE:${idStr(rec._id) || ymd}`,
    title: `Attendance — ${statusLabel}`,
    start: ymd,
    allDay: true,
    extendedProps: {
      category: CATEGORY.ATTENDANCE,
      eventClass: EVENT_CLASS.DERIVED,
      sourceType: 'ATTENDANCE',
      status: String(rec.status || ''),
      statusLabel,
      subtitle: subtitle || undefined,
      deepLink: '/attendance/me',
      details
    }
  };
};

/**
 * Build the full calendar payload for a range and scope.
 * @returns {{ events, summary, reps, scope, range }}
 */
const getCalendar = async (companyId, reqUser, query, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);

  const scope = query.scope === 'team' || query.scope === 'org' ? query.scope : 'mine';
  const isTeam = scope !== 'mine';

  const requestedRepIds =
    typeof query.repIds === 'string' && query.repIds.trim()
      ? query.repIds.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  const range = businessTime.coalesceBusinessDateRangeFromYmd(query.from, query.to, tz);
  const baseScope = await resolveBaseScope(companyId, reqUser, scope);
  const repScope = narrowByRequested(baseScope, requestedRepIds);

  // ── Bulk loads: exactly one query per source (no per-item loops). ───────────
  const planFilter = { companyId, date: range, isDeleted: { $ne: true } };
  if (repScope) planFilter.employeeId = { $in: repScope };

  const planItemsP = PlanItem.find(planFilter)
    .populate('doctorId', 'name locationName city')
    .populate('employeeId', 'name')
    .lean();

  // Attendance is personal day-context only (parity with the existing UI).
  const attendanceP =
    scope === 'mine'
      ? Attendance.find({
          companyId,
          employeeId: new mongoose.Types.ObjectId(String(reqUser.userId)),
          date: range,
          isDeleted: { $ne: true }
        }).lean()
      : Promise.resolve([]);

  const [planItems, attendance] = await Promise.all([planItemsP, attendanceP]);

  // ── Single transformation pass. ─────────────────────────────────────────────
  const events = [];
  for (const it of planItems) events.push(planItemToEvent(it, tz, isTeam));
  for (const rec of attendance) events.push(attendanceToEvent(rec, tz));

  // ── KPIs: single logic source, consistent across every view. ────────────────
  let planned = 0;
  let completed = 0;
  let missed = 0;
  for (const it of planItems) {
    const s = String(it.status || PLAN_ITEM_STATUS.PENDING).toUpperCase();
    if (s === PLAN_ITEM_STATUS.VISITED) completed += 1;
    else if (s === PLAN_ITEM_STATUS.MISSED) missed += 1;
    else planned += 1;
  }
  const denom = planned + completed + missed;
  const summary = {
    planned,
    completed,
    missed,
    attendance: attendance.length,
    coveragePct: denom > 0 ? Math.round((completed / denom) * 100) : null
  };

  // ── Rep directory for the team filter (full base scope → picker stays stable). ─
  const reps = isTeam ? await buildRepDirectory(companyId, baseScope, range) : [];

  return {
    events,
    summary,
    reps,
    scope,
    range: {
      from: businessTime.businessDayKeyFromUtcInstant(range.$gte, tz),
      to: businessTime.businessDayKeyFromUtcInstant(range.$lte, tz)
    }
  };
};

module.exports = { getCalendar };
