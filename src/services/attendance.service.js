const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const {
  ATTENDANCE_STATUS,
  ATTENDANCE_MARKED_BY,
  ATTENDANCE_CHECKIN_SOURCE,
  ATTENDANCE_CHECKOUT_SOURCE,
  ATTENDANCE_REQUEST_TYPE,
  LATE_CHECKIN_APPROVAL_STATUS
} = require('../constants/enums');
const businessTime = require('../utils/businessTime');
const attendancePolicyService = require('./attendancePolicy.service');
const attendanceAuditService = require('./attendanceAudit.service');
const attendanceWorkflowService = require('./attendanceWorkflow.service');
const checkInPolicyServiceV2 = require('./checkInPolicyServiceV2');

const round2 = (n) => Math.round(n * 100) / 100;

/** Earliest check-in on the business calendar day (0 = any time that day). */
const CHECK_IN_FROM_MINUTES = 0;

/** Shown when shift end + optional post-end cutoff has passed (self-service check-in only). */
const SHIFT_CHECKIN_CLOSED_USER_MESSAGE =
  'Shift has ended. Check-in is no longer allowed for today. Please submit an attendance correction request or contact your manager.';

const isLateCheckInPendingApproval = (rec) =>
  rec && rec.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING;

/** V2 check-in policy enrichment — never blocks attendance; atomic update by id. */
const enrichCheckInPolicyV2 = async (att, companyId, employeeId, ymd, tz, body) => {
  if (!att?._id) return att;
  try {
    const updated = await checkInPolicyServiceV2.applyCheckInPolicyV2(att._id, {
      companyId,
      employeeId,
      businessYmd: ymd,
      timeZone: tz,
      body: body || {}
    });
    return updated || att;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[attendance] enrichCheckInPolicyV2 failed', { companyId, employeeId, msg });
    return att;
  }
};

const todayYmd = (tz) => businessTime.nowInBusinessTime(tz).toISODate();
const dateDocFromYmd = (ymd, tz) => businessTime.businessDayStartUtc(ymd, tz);

const parseJsDateFromBody = (raw) => {
  if (raw instanceof Date) return raw;
  const dt = DateTime.fromISO(String(raw), { zone: 'utc' });
  if (!dt.isValid) throw new ApiError(400, 'Invalid date');
  return dt.toJSDate();
};

const resolveActionInstant = (body) => {
  if (body && body.capturedAt != null && String(body.capturedAt).trim() !== '') {
    return parseJsDateFromBody(body.capturedAt);
  }
  return businessTime.utcNow();
};

const applyCheckInGeo = (doc, body) => {
  if (!body || typeof body !== 'object') return;
  if (body.lat != null) doc.checkInLat = body.lat;
  if (body.lng != null) doc.checkInLng = body.lng;
  if (body.accuracy != null) doc.checkInAccuracy = body.accuracy;
};

const applyCheckOutGeo = (doc, body) => {
  if (!body || typeof body !== 'object') return;
  if (body.lat != null) doc.checkOutLat = body.lat;
  if (body.lng != null) doc.checkOutLng = body.lng;
  if (body.accuracy != null) doc.checkOutAccuracy = body.accuracy;
};

const mergeNotes = (existing, incoming) => {
  if (incoming == null) return existing;
  const next = String(incoming).trim();
  if (!next) return existing;
  return next;
};

const findTodayRecord = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  return Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
};

const previousBusinessYmd = (tz) =>
  DateTime.now().setZone(businessTime.requireCompanyIanaZone(tz)).minus({ days: 1 }).toISODate();

/**
 * Previous calendar day still within overnight shift end window (e.g. before 02:00 after 18:00 start).
 */
const findOvernightOpenPreviousBusinessDay = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  if (!flags.attendancePoliciesEnabled) return null;

  const ps = await attendancePolicyService.getEffectivePolicyAndShift(companyId, employeeId);
  const shift = ps?.shift;
  if (!shift) return null;

  if (!attendancePolicyService.isOvernightShift(shift)) return null;

  const mins = businessTime.businessMinutesSinceMidnight(tz);
  if (mins > shift.endMinutes) return null;

  const prevYmd = previousBusinessYmd(tz);
  const prevDoc = dateDocFromYmd(prevYmd, tz);
  const prev = await Attendance.findOne({
    companyId,
    employeeId,
    date: prevDoc,
    isDeleted: { $ne: true }
  });
  if (prev?.checkInTime && !prev.checkOutTime) return prev;
  return null;
};

const resolveOpenAttendanceForCheckout = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  const today = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
  if (today?.checkInTime && !today.checkOutTime) return today;

  const prevOpen = await findOvernightOpenPreviousBusinessDay(companyId, employeeId, tz);
  if (prevOpen) return prevOpen;

  return today;
};

const checkIn = async (companyId, employeeId, timeZone, body = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const user = await User.findOne({
    _id: employeeId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });
  if (!user) throw new ApiError(403, 'Active employee not found');

  const checkInInstant = resolveActionInstant(body);
  const checkInLuxon = businessTime.toBusinessTime(checkInInstant, tz);
  const ymd =
    body && body.capturedAt != null && String(body.capturedAt).trim() !== ''
      ? businessTime.businessDayKeyFromUtcInstant(checkInInstant, tz)
      : todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  const mins =
    body && body.capturedAt != null && String(body.capturedAt).trim() !== ''
      ? businessTime.businessMinutesSinceMidnightForInstant(checkInInstant, tz)
      : businessTime.businessMinutesSinceMidnight(tz);

  if (mins < CHECK_IN_FROM_MINUTES) {
    throw new ApiError(400, 'Check-in is not available before the configured local opening time');
  }

  const existing = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
  if (existing?.checkInTime) {
    if (isLateCheckInPendingApproval(existing)) {
      throw new ApiError(
        400,
        'Your late check-in is waiting for manager approval. You will be able to check out after it is approved.'
      );
    }
    throw new ApiError(400, 'Already checked in today');
  }

  const overnightOpen = await findOvernightOpenPreviousBusinessDay(companyId, employeeId, tz);
  if (overnightOpen) {
    throw new ApiError(400, 'Check out your previous shift before checking in again.');
  }

  const now = checkInInstant;
  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  let lateMinutes = null;
  let workShiftId = null;
  let policyId = null;

  if (flags.attendancePoliciesEnabled) {
    const ps = await attendancePolicyService.getEffectivePolicyAndShift(companyId, employeeId);
    if (ps?.shift) {
      if (
        attendancePolicyService.isSelfCheckInPastShiftClose(ymd, ps.shift, tz, checkInLuxon)
      ) {
        throw new ApiError(400, SHIFT_CHECKIN_CLOSED_USER_MESSAGE);
      }
      lateMinutes = attendancePolicyService.computeLateMinutes(mins, ps.shift);
      workShiftId = ps.shift._id;
      policyId = ps.policy?._id || null;
    }
  }

  const wantsStrictLateWorkflow =
    flags.attendancePoliciesEnabled &&
    flags.strictLateBlocking &&
    lateMinutes > 0 &&
    !flags.allowCheckInWhenLate;

  if (wantsStrictLateWorkflow) {
    if (!flags.attendanceApprovalsEnabled) {
      throw new ApiError(
        400,
        'Late check-in requires manager approval, but attendance approvals are not enabled for your company. Turn on approvals under attendance governance, or enable “Allow check-in when late”.'
      );
    }

    const reasonRaw = body && body.reason != null ? String(body.reason).trim() : '';
    const reason = reasonRaw || 'Late check-in — submitted for manager approval.';

    let att = existing;
    if (att) {
      att.status = ATTENDANCE_STATUS.PRESENT;
      att.checkInTime = now;
      att.checkInSource = ATTENDANCE_CHECKIN_SOURCE.USER;
      att.lateMinutes = lateMinutes;
      att.workShiftId = workShiftId;
      att.policyId = policyId;
      att.markedBy = ATTENDANCE_MARKED_BY.SELF;
      att.lateCheckInApprovalStatus = LATE_CHECKIN_APPROVAL_STATUS.PENDING;
      att.notes = mergeNotes(att.notes, body.notes);
      applyCheckInGeo(att, body);
      await att.save();
    } else {
      att = await Attendance.create({
        companyId,
        employeeId,
        date: dateDoc,
        status: ATTENDANCE_STATUS.PRESENT,
        checkInTime: now,
        checkInSource: ATTENDANCE_CHECKIN_SOURCE.USER,
        lateMinutes,
        workShiftId,
        policyId,
        markedBy: ATTENDANCE_MARKED_BY.SELF,
        lateCheckInApprovalStatus: LATE_CHECKIN_APPROVAL_STATUS.PENDING,
        notes: mergeNotes(undefined, body.notes)
      });
      applyCheckInGeo(att, body);
      await att.save();
    }

    if (flags.attendanceGovernanceEnabled) {
      await attendanceAuditService.log({
        companyId,
        attendanceId: att._id,
        actorUserId: employeeId,
        source: 'USER',
        action: 'CHECK_IN',
        after: att.toObject(),
        meta: { lateMinutes, lateCheckInApprovalStatus: LATE_CHECKIN_APPROVAL_STATUS.PENDING }
      });
    }

    try {
      await attendanceWorkflowService.submitRequest({
        companyId,
        requesterId: employeeId,
        type: ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL,
        reason,
        attendanceId: att._id,
        payload: { lateMinutes }
      });
    } catch (err) {
      await Attendance.findOneAndUpdate(
        { _id: att._id, companyId, employeeId },
        {
          $set: {
            checkInTime: null,
            status: ATTENDANCE_STATUS.ABSENT
          },
          $unset: {
            checkInSource: 1,
            lateMinutes: 1,
            workShiftId: 1,
            policyId: 1,
            lateCheckInApprovalStatus: 1,
            activeRequestId: 1
          }
        }
      );
      throw err;
    }

    await enrichCheckInPolicyV2(att, companyId, employeeId, ymd, tz, body);
    return att;
  }

  let docToSave = existing;
  if (docToSave) {
    docToSave.status = ATTENDANCE_STATUS.PRESENT;
    docToSave.checkInTime = now;
    docToSave.checkInSource = ATTENDANCE_CHECKIN_SOURCE.USER;
    docToSave.lateMinutes = lateMinutes;
    docToSave.workShiftId = workShiftId;
    docToSave.policyId = policyId;
    docToSave.markedBy = ATTENDANCE_MARKED_BY.SELF;
    docToSave.lateCheckInApprovalStatus = undefined;
    docToSave.notes = mergeNotes(docToSave.notes, body.notes);
    applyCheckInGeo(docToSave, body);
    await docToSave.save();
  } else {
    docToSave = await Attendance.create({
      companyId,
      employeeId,
      date: dateDoc,
      status: ATTENDANCE_STATUS.PRESENT,
      checkInTime: now,
      checkInSource: ATTENDANCE_CHECKIN_SOURCE.USER,
      lateMinutes,
      workShiftId,
      policyId,
      markedBy: ATTENDANCE_MARKED_BY.SELF,
      notes: mergeNotes(undefined, body.notes)
    });
    applyCheckInGeo(docToSave, body);
    await docToSave.save();
  }

  if (flags.attendanceGovernanceEnabled) {
    await attendanceAuditService.log({
      companyId,
      attendanceId: docToSave._id,
      actorUserId: employeeId,
      source: 'USER',
      action: 'CHECK_IN',
      after: docToSave.toObject(),
      meta: { lateMinutes }
    });
  }

  if (lateMinutes > 0 && flags.autoRequestOnLateCheckIn && flags.attendanceApprovalsEnabled) {
    try {
      await attendanceWorkflowService.submitRequest({
        companyId,
        requesterId: employeeId,
        type: ATTENDANCE_REQUEST_TYPE.LATE_ARRIVAL,
        reason: 'Automated: late check-in recorded (pending acknowledgment).',
        attendanceId: docToSave._id,
        payload: {}
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[attendance] autoRequestOnLateCheckIn failed', { companyId, employeeId, msg });
    }
  }

  await enrichCheckInPolicyV2(docToSave, companyId, employeeId, ymd, tz, body);
  return docToSave;
};

const checkOut = async (companyId, employeeId, timeZone, body = {}) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const rec = await resolveOpenAttendanceForCheckout(companyId, employeeId, tz);

  if (!rec || !rec.checkInTime) {
    throw new ApiError(400, 'Check in before checking out');
  }
  if (rec.checkOutTime) {
    throw new ApiError(400, 'Already checked out');
  }
  if (isLateCheckInPendingApproval(rec)) {
    throw new ApiError(400, 'Check-out is unavailable until your late check-in is approved by your manager.');
  }

  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  const before = rec.toObject();
  rec.checkOutTime = resolveActionInstant(body);
  rec.checkOutSource = ATTENDANCE_CHECKOUT_SOURCE.USER;
  rec.notes = mergeNotes(rec.notes, body.notes);
  applyCheckOutGeo(rec, body);
  await rec.save();

  if (flags.attendanceGovernanceEnabled) {
    await attendanceAuditService.log({
      companyId,
      attendanceId: rec._id,
      actorUserId: employeeId,
      source: 'USER',
      action: 'CHECK_OUT',
      before,
      after: rec.toObject()
    });
  }
  return rec;
};

const markSelf = async (companyId, employeeId, body = {}, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const existing = await findTodayRecord(companyId, employeeId, tz);
  if (!existing) {
    return checkIn(companyId, employeeId, tz, body);
  }
  if (body.checkOutTime !== undefined) {
    if (isLateCheckInPendingApproval(existing)) {
      throw new ApiError(400, 'Check-out is unavailable until your late check-in is approved by your manager.');
    }
    const flags = await attendancePolicyService.getCompanyFlags(companyId);
    const before = existing.toObject();
    existing.checkOutTime = parseJsDateFromBody(body.checkOutTime);
    existing.checkOutSource = ATTENDANCE_CHECKOUT_SOURCE.USER;
    if (body.notes !== undefined) existing.notes = body.notes;
    await existing.save();
    if (flags.attendanceGovernanceEnabled) {
      await attendanceAuditService.log({
        companyId,
        attendanceId: existing._id,
        actorUserId: employeeId,
        source: 'USER',
        action: 'CHECK_OUT_MARK',
        before,
        after: existing.toObject()
      });
    }
    return existing;
  }
  if (body.notes !== undefined) {
    existing.notes = body.notes;
    await existing.save();
    return existing;
  }
  throw new ApiError(400, 'Already checked in today. Use POST /attendance/checkout to check out.');
};

const getMeToday = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  const todayRec = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });

  let doc = todayRec;
  if (!(todayRec?.checkInTime && !todayRec?.checkOutTime)) {
    const prevOpen = await findOvernightOpenPreviousBusinessDay(companyId, employeeId, tz);
    if (prevOpen) doc = prevOpen;
  }

  const user = await User.findOne({
    _id: employeeId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });

  const mins = businessTime.businessMinutesSinceMidnight(tz);
  const hasOpenShift = Boolean(doc?.checkInTime && !doc?.checkOutTime);
  const pendingLateOnOpen = isLateCheckInPendingApproval(doc);
  const canCheckOut = hasOpenShift && !pendingLateOnOpen;

  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  const policySummary = await attendancePolicyService.policySummaryForEmployee(companyId, employeeId, tz, ymd);
  const shiftCheckInClosed = Boolean(policySummary?.checkInClosedForShift);

  let canCheckIn =
    Boolean(user) && !todayRec?.checkInTime && !hasOpenShift && mins >= CHECK_IN_FROM_MINUTES;
  if (shiftCheckInClosed) {
    canCheckIn = false;
  }

  const rejectedLateToday =
    todayRec?.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.REJECTED && !todayRec?.checkInTime;

  let uiStatus = 'NOT_MARKED';
  if (pendingLateOnOpen && doc?.checkInTime && !doc?.checkOutTime) {
    uiStatus = 'LATE_CHECKIN_PENDING';
  } else if (rejectedLateToday) {
    uiStatus = 'LATE_CHECKIN_REJECTED';
  } else if (shiftCheckInClosed && !todayRec?.checkInTime && !hasOpenShift) {
    uiStatus = 'SHIFT_CHECKIN_CLOSED';
  } else if (doc?.checkInTime && !doc.checkOutTime) uiStatus = 'PRESENT';
  else if (doc?.checkOutTime) uiStatus = 'CHECKED_OUT';

  const base = doc ? doc.toObject() : { checkInTime: null, checkOutTime: null, status: null };
  if (base.checkOutTime && !base.checkOutSource) {
    base.checkOutSource = ATTENDANCE_CHECKOUT_SOURCE.UNKNOWN_LEGACY;
  }

  const businessDate = doc?.date
    ? businessTime.toBusinessTime(doc.date, tz).toISODate()
    : ymd;

  const checkInPolicyV2 = await checkInPolicyServiceV2.previewForEmployeeToday(
    companyId,
    employeeId,
    tz
  );
  const policyV2Fields = checkInPolicyServiceV2.buildResponseFields(base);

  return {
    ...base,
    ...policyV2Fields,
    canCheckIn,
    canCheckOut,
    uiStatus,
    businessDate,
    pstDate: businessDate,
    checkInPolicyV2,
    governance: {
      attendanceGovernanceEnabled: flags.attendanceGovernanceEnabled,
      attendancePoliciesEnabled: flags.attendancePoliciesEnabled,
      attendanceApprovalsEnabled: flags.attendanceApprovalsEnabled,
      strictLateBlocking: flags.strictLateBlocking,
      allowCheckInWhenLate: flags.allowCheckInWhenLate,
      autoRequestOnLateCheckIn: flags.autoRequestOnLateCheckIn,
      attendanceSystemMode: checkInPolicyV2.enabled
        ? 'CHECKIN_POLICY_V2'
        : 'LEGACY'
    },
    shiftCheckInClosed,
    shiftCheckInClosedMessage: shiftCheckInClosed ? SHIFT_CHECKIN_CLOSED_USER_MESSAGE : undefined,
    policySummary
  };
};

const dashboardLabel = (rec) => {
  if (!rec) return 'NOT_MARKED';
  if (rec.status === ATTENDANCE_STATUS.LEAVE) return 'LEAVE';
  if (rec.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) return 'LATE_CHECKIN_PENDING';
  return rec.status;
};

const listToday = async (companyId, timeZone, visibleUserIds = null) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);

  const userFilter = {
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  };
  if (visibleUserIds && visibleUserIds.length) {
    userFilter._id = { $in: visibleUserIds };
  }

  const users = await User.find(userFilter).select('name role').sort({ name: 1 }).lean();

  const recs = await Attendance.find({
    companyId,
    date: dateDoc,
    isDeleted: { $ne: true },
    ...(visibleUserIds && visibleUserIds.length ? { employeeId: { $in: visibleUserIds } } : {})
  }).lean();

  const byEmp = new Map(recs.map((r) => [r.employeeId.toString(), r]));
  const companyV2 = await checkInPolicyServiceV2.getCompanyForCheckInPolicy(companyId);
  const v2Enabled = checkInPolicyServiceV2.isV2Mode(companyV2);

  const employees = users.map((u) => {
    const r = byEmp.get(u._id.toString());
    const status = dashboardLabel(r);
    const hasCheckedOut = Boolean(r?.checkOutTime);
    const lateMinutes = r?.lateMinutes != null ? r.lateMinutes : null;
    const row = {
      employeeId: u._id,
      name: u.name,
      role: u.role,
      status,
      lateMinutes,
      checkInTime: businessTime.formatHmBusiness(r?.checkInTime, tz),
      checkOutTime: businessTime.formatHmBusiness(r?.checkOutTime, tz),
      hasCheckedOut
    };
    if (v2Enabled && r) {
      Object.assign(row, checkInPolicyServiceV2.buildResponseFields(r));
    }
    return row;
  });

  let presentPayroll = 0;
  let pendingLateApproval = 0;
  let notMarked = 0;
  let absent = 0;
  let halfDay = 0;
  let leave = 0;
  let lateRecords = 0;
  let missingCheckout = 0;
  let outOfZoneToday = 0;
  let withinZoneToday = 0;

  for (const e of employees) {
    if (e.status === 'NOT_MARKED') {
      notMarked += 1;
    } else if (e.status === 'LATE_CHECKIN_PENDING') {
      pendingLateApproval += 1;
    } else if (e.status === ATTENDANCE_STATUS.PRESENT) {
      presentPayroll += 1;
    } else if (e.status === ATTENDANCE_STATUS.ABSENT) absent += 1;
    else if (e.status === ATTENDANCE_STATUS.HALF_DAY) halfDay += 1;
    else if (e.status === ATTENDANCE_STATUS.LEAVE) leave += 1;
  }

  /** Operational sub-counts within the scoped employee list (align with exception semantics). */
  for (const e of employees) {
    if (e.status === ATTENDANCE_STATUS.LEAVE) continue;
    const r = byEmp.get(String(e.employeeId));
    if (!r) continue;
    if ((r.lateMinutes || 0) > 0 && e.status !== 'LATE_CHECKIN_PENDING') lateRecords += 1;
    if (r.checkInTime && !r.checkOutTime && e.status !== 'LATE_CHECKIN_PENDING') missingCheckout += 1;
    if (v2Enabled && r?.attendanceLocationStatus === 'OUT_OF_ZONE') outOfZoneToday += 1;
    if (v2Enabled && r?.attendanceLocationStatus === 'WITHIN_ZONE') withinZoneToday += 1;
  }

  const flags = await attendancePolicyService.getCompanyFlags(companyId);
  const shiftMetaByEmp = new Map();
  if (flags.attendancePoliciesEnabled && employees.length) {
    await Promise.all(
      employees.map(async (e) => {
        try {
          const ps = await attendancePolicyService.getEffectivePolicyAndShift(
            companyId,
            e.employeeId,
            dateDoc,
            { companyFlags: flags }
          );
          if (ps?.shift) {
            const policyName = ps.policy?.name?.trim() || null;
            const shiftName = ps.shift.name?.trim() || null;
            shiftMetaByEmp.set(e.employeeId.toString(), {
              shiftId: ps.shift._id.toString(),
              shiftName,
              scheduleLabel: policyName || shiftName || 'Schedule'
            });
          }
        } catch {
          /* ignore single-user resolution failures */
        }
      })
    );
  }

  const distribution = {
    'Present (payroll)': presentPayroll,
    'Pending late approval': pendingLateApproval,
    Absent: absent,
    'Half-Day': halfDay,
    Leave: leave,
    'Not marked': notMarked
  };

  return {
    businessDate: ymd,
    attendanceSystemMode: v2Enabled ? 'CHECKIN_POLICY_V2' : 'LEGACY',
    employees: employees.map((e) => {
      const m = shiftMetaByEmp.get(e.employeeId.toString());
      return {
        employeeId: e.employeeId.toString(),
        name: e.name,
        status: e.status,
        lateMinutes: e.lateMinutes,
        checkInTime: e.checkInTime,
        checkOutTime: e.checkOutTime,
        hasCheckedOut: e.hasCheckedOut,
        shiftId: m?.shiftId ?? null,
        shiftName: m?.shiftName ?? null,
        scheduleLabel: m?.scheduleLabel ?? null,
        ...(v2Enabled
          ? {
              attendanceLocationStatus: e.attendanceLocationStatus,
              distanceFromCheckInPoint: e.distanceFromCheckInPoint,
              requiredCheckInLocation: e.requiredCheckInLocation
            }
          : {})
      };
    }),
    summary: {
      presentPayroll,
      pendingLateApproval,
      lateToday: lateRecords,
      missingCheckoutToday: missingCheckout,
      notMarked,
      absent,
      totalEmployees: employees.length,
      ...(v2Enabled ? { outOfZoneToday, withinZoneToday } : {}),
      /** @deprecated Use presentPayroll (payroll-aligned). */
      present: presentPayroll
    },
    distribution
  };
};

const getMonthStatsForPayroll = async (companyId, employeeId, monthStr, asOfDate, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const asOf = asOfDate == null ? businessTime.utcNow() : asOfDate;
  const [Y, M] = monthStr.split('-').map(Number);
  if (!Y || !M || M < 1 || M > 12) throw new ApiError(400, 'Invalid month (use YYYY-MM)');

  const ymds = businessTime.businessMonthYmds(monthStr, tz);
  if (!ymds.length) throw new ApiError(400, 'Invalid month');

  const ymdSet = new Set(ymds);
  const monthStartLocal = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: tz }).startOf('month');
  const monthEndLocal = monthStartLocal.endOf('month');
  const rangeStart = monthStartLocal.minus({ days: 2 }).startOf('day').toUTC().toJSDate();
  const rangeEnd = monthEndLocal.plus({ days: 2 }).endOf('day').toUTC().toJSDate();

  const candidates = await Attendance.find({
    companyId,
    employeeId,
    date: { $gte: rangeStart, $lte: rangeEnd },
    isDeleted: { $ne: true }
  }).lean();

  const byYmd = new Map();
  for (const r of candidates) {
    const k = businessTime.businessDayKeyFromUtcInstant(r.date, tz);
    if (ymdSet.has(k)) byYmd.set(k, r);
  }

  const todayLocal = DateTime.fromJSDate(asOf instanceof Date ? asOf : new Date(asOf), { zone: 'utc' })
    .setZone(tz)
    .startOf('day');
  const monthLastLocal = monthStartLocal.endOf('month').startOf('day');
  const eligibleThrough = todayLocal < monthLastLocal ? todayLocal : monthLastLocal;

  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;

  for (const ymd of ymds) {
    const dayLocal = DateTime.fromISO(ymd, { zone: tz }).startOf('day');
    if (dayLocal > eligibleThrough) break;

    const rec = byYmd.get(ymd);
    if (!rec) {
      absentDays += 1;
      continue;
    }
    switch (rec.status) {
      case ATTENDANCE_STATUS.PRESENT:
        if (rec.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) {
          absentDays += 1;
        } else {
          presentDays += 1;
        }
        break;
      case ATTENDANCE_STATUS.ABSENT:
        absentDays += 1;
        break;
      case ATTENDANCE_STATUS.HALF_DAY:
        halfDays += 1;
        break;
      case ATTENDANCE_STATUS.LEAVE:
        leaveDays += 1;
        break;
      default:
        absentDays += 1;
    }
  }

  return {
    presentDays,
    absentDays,
    halfDays,
    leaveDays,
    totalDaysInMonth: ymds.length,
    monthStart: dateDocFromYmd(ymds[0], tz),
    monthEnd: dateDocFromYmd(ymds[ymds.length - 1], tz)
  };
};

const runAutoCheckoutForCompanyDay = async (companyId, ymd, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const end = businessTime.businessDayToUtcRange(ymd, tz).$lte;
  const dateDoc = dateDocFromYmd(ymd, tz);
  const cid = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(String(companyId)) : companyId;

  const res = await Attendance.updateMany(
    {
      companyId: cid,
      date: dateDoc,
      status: ATTENDANCE_STATUS.PRESENT,
      checkInTime: { $ne: null },
      lateCheckInApprovalStatus: { $ne: LATE_CHECKIN_APPROVAL_STATUS.PENDING },
      $or: [{ checkOutTime: null }, { checkOutTime: { $exists: false } }],
      isDeleted: { $ne: true }
    },
    { $set: { checkOutTime: end, checkOutSource: ATTENDANCE_CHECKOUT_SOURCE.SYSTEM_AUTO } }
  );

  return res.modifiedCount ?? 0;
};

/** Cron: run shortly after local midnight per company (see job). */
const runAutoCheckoutTick = async () => {
  const Company = require('../models/Company');
  const companies = await Company.find({ isActive: true }).select('_id timeZone').lean();
  let n = 0;
  for (const c of companies) {
    const tz = businessTime.getTimeZone(c);
    const local = businessTime.nowInBusinessTime(tz);
    if (local.hour === 0 && local.minute < 30) {
      const ymd = local.minus({ days: 1 }).toISODate();
      n += await runAutoCheckoutForCompanyDay(c._id, ymd, tz);
    }
  }
  return n;
};

const report = async (companyId, query, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const { employeeId, startDate, endDate, attendanceLocationStatus } = query;
  if (!employeeId || !startDate || !endDate) {
    throw new ApiError(400, 'employeeId, startDate, and endDate are required');
  }

  const toYmd = (raw) => {
    if (raw instanceof Date) {
      if (Number.isNaN(raw.getTime())) throw new ApiError(400, 'Invalid date');
      return DateTime.fromJSDate(raw, { zone: tz }).toISODate();
    }
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dt = DateTime.fromISO(s, { zone: 'utc' });
    if (!dt.isValid) throw new ApiError(400, 'Invalid date');
    return dt.setZone(tz).toISODate();
  };

  const startYmd = toYmd(startDate);
  const endYmd = toYmd(endDate);

  let cur = DateTime.fromISO(startYmd, { zone: tz }).startOf('day');
  const end = DateTime.fromISO(endYmd, { zone: tz }).startOf('day');
  if (cur > end) throw new ApiError(400, 'startDate must be before endDate');

  const ymds = [];
  while (cur <= end) {
    ymds.push(cur.toISODate());
    cur = cur.plus({ days: 1 });
  }

  const ymdSet = new Set(ymds);
  const startDt = DateTime.fromISO(startYmd, { zone: tz }).startOf('day');
  const endDt = DateTime.fromISO(endYmd, { zone: tz }).startOf('day');
  const rangeStart = startDt.minus({ days: 2 }).startOf('day').toUTC().toJSDate();
  const rangeEnd = endDt.plus({ days: 2 }).endOf('day').toUTC().toJSDate();

  const candidates = await Attendance.find({
    companyId,
    employeeId,
    date: { $gte: rangeStart, $lte: rangeEnd },
    isDeleted: { $ne: true }
  })
    .sort({ date: 1 })
    .lean();

  const records = candidates.filter((r) => ymdSet.has(businessTime.businessDayKeyFromUtcInstant(r.date, tz)));

  const companyV2 = await checkInPolicyServiceV2.getCompanyForCheckInPolicy(companyId);
  const v2Enabled = checkInPolicyServiceV2.isV2Mode(companyV2);

  let filteredRecords = records;
  if (v2Enabled && attendanceLocationStatus) {
    filteredRecords = records.filter(
      (r) => r.attendanceLocationStatus === attendanceLocationStatus
    );
  }

  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;
  let outOfZoneDays = 0;
  let withinZoneDays = 0;

  for (const r of filteredRecords) {
    switch (r.status) {
      case ATTENDANCE_STATUS.PRESENT:
        if (r.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) {
          absentDays += 1;
        } else {
          presentDays += 1;
        }
        break;
      case ATTENDANCE_STATUS.ABSENT:
        absentDays += 1;
        break;
      case ATTENDANCE_STATUS.HALF_DAY:
        halfDays += 1;
        break;
      case ATTENDANCE_STATUS.LEAVE:
        leaveDays += 1;
        break;
      default:
        break;
    }
    if (v2Enabled && r.attendanceLocationStatus === 'OUT_OF_ZONE') outOfZoneDays += 1;
    if (v2Enabled && r.attendanceLocationStatus === 'WITHIN_ZONE') withinZoneDays += 1;
  }

  const sa = DateTime.fromISO(startYmd, { zone: tz }).toMillis();
  const sb = DateTime.fromISO(endYmd, { zone: tz }).toMillis();
  const totalDays = Math.floor((sb - sa) / 86400000) + 1;

  return {
    records: filteredRecords,
    attendanceSystemMode: v2Enabled ? 'CHECKIN_POLICY_V2' : 'LEGACY',
    summary: {
      totalDays,
      presentDays,
      absentDays,
      halfDays,
      leaveDays,
      ...(v2Enabled ? { outOfZoneDays, withinZoneDays } : {})
    }
  };
};

const adminSetAttendanceToday = async (companyId, targetEmployeeId, status, timeZone, actorUserId = null) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  if (!Object.values(ATTENDANCE_STATUS).includes(status)) {
    throw new ApiError(400, 'Invalid attendance status');
  }

  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);

  const target = await User.findOne({
    _id: targetEmployeeId,
    companyId,
    isDeleted: { $ne: true }
  }).lean();
  if (!target) throw new ApiError(404, 'Employee not found');

  let doc = await Attendance.findOne({
    companyId,
    employeeId: targetEmployeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });

  const stampLine = (verb) => `Admin ${verb} ${status} — ${businessTime.utcNowIso()}`;
  const flags = await attendancePolicyService.getCompanyFlags(companyId);

  if (!doc) {
    const base = {
      companyId,
      employeeId: targetEmployeeId,
      date: dateDoc,
      status,
      markedBy: ATTENDANCE_MARKED_BY.ADMIN,
      notes: stampLine('set')
    };
    if (status === ATTENDANCE_STATUS.PRESENT) {
      base.checkInTime = businessTime.utcNow();
      base.checkOutTime = null;
      base.checkInSource = ATTENDANCE_CHECKIN_SOURCE.ADMIN;
      base.checkOutSource = undefined;
    } else {
      base.checkInTime = null;
      base.checkOutTime = null;
      base.checkInSource = undefined;
      base.checkOutSource = undefined;
    }
    doc = await Attendance.create(base);
    if (flags.attendanceGovernanceEnabled && actorUserId) {
      await attendanceAuditService.log({
        companyId,
        attendanceId: doc._id,
        actorUserId,
        source: 'ADMIN',
        action: 'ADMIN_SET_TODAY_CREATE',
        after: doc.toObject(),
        meta: { targetEmployeeId: String(targetEmployeeId), status }
      });
    }
    return doc;
  }

  const before = doc.toObject();

  doc.status = status;
  doc.markedBy = ATTENDANCE_MARKED_BY.ADMIN;

  switch (status) {
    case ATTENDANCE_STATUS.PRESENT:
      if (!doc.checkInTime) doc.checkInTime = businessTime.utcNow();
      doc.checkInSource = doc.checkInSource || ATTENDANCE_CHECKIN_SOURCE.ADMIN;
      doc.checkOutTime = null;
      doc.checkOutSource = undefined;
      doc.lateCheckInApprovalStatus = undefined;
      break;
    case ATTENDANCE_STATUS.ABSENT:
    case ATTENDANCE_STATUS.HALF_DAY:
    case ATTENDANCE_STATUS.LEAVE:
      doc.checkInTime = null;
      doc.checkOutTime = null;
      doc.checkInSource = undefined;
      doc.checkOutSource = undefined;
      doc.lateCheckInApprovalStatus = undefined;
      break;
    default:
      break;
  }

  const line = stampLine('updated');
  doc.notes = doc.notes ? `${doc.notes}\n${line}` : line;
  await doc.save();

  if (flags.attendanceGovernanceEnabled && actorUserId) {
    await attendanceAuditService.log({
      companyId,
      attendanceId: doc._id,
      actorUserId,
      source: 'ADMIN',
      action: 'ADMIN_SET_TODAY_UPDATE',
      before,
      after: doc.toObject(),
      meta: { targetEmployeeId: String(targetEmployeeId), status }
    });
  }

  if (flags.attendanceApprovalsEnabled && actorUserId) {
    try {
      await attendanceWorkflowService.resolveLinkedRequestsForAdminAttendanceOverride({
        companyId,
        attendanceId: doc._id,
        actorUserId,
        newAttendanceStatus: status,
        note: `Company attendance correction: ${status}`
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[attendance] resolveLinkedRequestsForAdminAttendanceOverride', err?.message || err);
    }
  }

  return doc;
};

const adminMarkAbsentToday = async (companyId, targetEmployeeId, timeZone, actorUserId = null) => {
  return adminSetAttendanceToday(companyId, targetEmployeeId, ATTENDANCE_STATUS.ABSENT, timeZone, actorUserId);
};

const monthlySummary = async (companyId, employeeId, monthStr, dailyAllowanceRate, timeZone) => {
  const stats = await getMonthStatsForPayroll(companyId, employeeId, monthStr, businessTime.utcNow(), timeZone);
  const rate = Number(dailyAllowanceRate) || 0;
  const dailyAllowanceEarned = round2(stats.presentDays * rate + stats.halfDays * rate * 0.5);

  return {
    month: monthStr,
    presentDays: stats.presentDays,
    absentDays: stats.absentDays,
    halfDays: stats.halfDays,
    leaveDays: stats.leaveDays,
    dailyAllowanceEarned
  };
};

const assertEmployeePresentForVisitDate = async (companyId, employeeId, visitDateInput, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  let ymd;
  if (typeof visitDateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visitDateInput)) {
    ymd = visitDateInput;
  } else {
    const js = visitDateInput instanceof Date ? visitDateInput : parseJsDateFromBody(visitDateInput);
    ymd = businessTime.businessDayKeyFromUtcInstant(js, tz);
  }
  const dateDoc = dateDocFromYmd(ymd, tz);
  const rec = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
  if (!rec || rec.status !== ATTENDANCE_STATUS.PRESENT || isLateCheckInPendingApproval(rec)) {
    throw new ApiError(400, 'Attendance must be approved PRESENT on the visit date to log this visit');
  }
  return rec;
};

module.exports = {
  assertEmployeePresentForVisitDate,
  monthBounds: (monthStr, timeZone) => {
    const tz = businessTime.requireCompanyIanaZone(timeZone);
    const ymds = businessTime.businessMonthYmds(monthStr, tz);
    if (!ymds.length) throw new ApiError(400, 'Invalid month (use YYYY-MM)');
    const start = dateDocFromYmd(ymds[0], tz);
    const end = dateDocFromYmd(ymds[ymds.length - 1], tz);
    return { start, end, totalDays: ymds.length, year: +monthStr.slice(0, 4), month: +monthStr.slice(5, 7) };
  },
  getMonthStatsForPayroll,
  checkIn,
  checkOut,
  markSelf,
  getMeToday,
  listToday,
  adminSetAttendanceToday,
  adminMarkAbsentToday,
  report,
  monthlySummary,
  runAutoCheckoutPst: runAutoCheckoutTick,
  runAutoCheckoutTick,
  runAutoCheckoutForCompanyDay,
  round2
};
