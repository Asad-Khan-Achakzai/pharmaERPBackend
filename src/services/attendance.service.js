const { DateTime } = require('luxon');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { ATTENDANCE_STATUS, ATTENDANCE_MARKED_BY } = require('../constants/enums');
const {
  TZ,
  pstTodayYmd,
  pstMinutesSinceMidnight,
  dateDocFromPstYmd,
  endOfPstDayJsDate,
  formatHmPst,
  pstMonthYmds,
  pstYmdFromJsDate
} = require('../utils/attendancePst');

const round2 = (n) => Math.round(n * 100) / 100;

/** Earliest check-in on the Pacific business day (0 = any time that day). Previously 8:00 AM PT, which disabled the UI for most international users. */
const CHECK_IN_FROM_MINUTES = 0;

const findTodayRecord = async (companyId, employeeId) => {
  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);
  return Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
};

const checkIn = async (companyId, employeeId) => {
  const user = await User.findOne({
    _id: employeeId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });
  if (!user) throw new ApiError(403, 'Active employee not found');

  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);
  const mins = pstMinutesSinceMidnight();

  if (mins < CHECK_IN_FROM_MINUTES) {
    throw new ApiError(400, 'Check-in is available from 8:00 AM Pacific time');
  }

  const existing = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
  if (existing?.checkInTime) {
    throw new ApiError(400, 'Already checked in today');
  }

  const now = new Date();
  return Attendance.create({
    companyId,
    employeeId,
    date: dateDoc,
    status: ATTENDANCE_STATUS.PRESENT,
    checkInTime: now,
    markedBy: ATTENDANCE_MARKED_BY.SELF
  });
};

const checkOut = async (companyId, employeeId) => {
  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);
  const rec = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });

  if (!rec || !rec.checkInTime) {
    throw new ApiError(400, 'Check in before checking out');
  }
  if (rec.checkOutTime) {
    throw new ApiError(400, 'Already checked out');
  }

  rec.checkOutTime = new Date();
  await rec.save();
  return rec;
};

/**
 * Legacy: first call acts as check-in (rules apply); optional manual checkOutTime; else duplicate → error with hint.
 */
const markSelf = async (companyId, employeeId, body = {}) => {
  const existing = await findTodayRecord(companyId, employeeId);
  if (!existing) {
    return checkIn(companyId, employeeId);
  }
  if (body.checkOutTime !== undefined) {
    existing.checkOutTime = new Date(body.checkOutTime);
    if (body.notes !== undefined) existing.notes = body.notes;
    await existing.save();
    return existing;
  }
  if (body.notes !== undefined) {
    existing.notes = body.notes;
    await existing.save();
    return existing;
  }
  throw new ApiError(400, 'Already checked in today. Use POST /attendance/checkout to check out.');
};

const getMeToday = async (companyId, employeeId) => {
  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);
  const doc = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });

  const user = await User.findOne({
    _id: employeeId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });

  const mins = pstMinutesSinceMidnight();
  const canCheckIn = Boolean(user) && !doc && mins >= CHECK_IN_FROM_MINUTES;
  const canCheckOut = Boolean(doc?.checkInTime && !doc.checkOutTime);

  let uiStatus = 'NOT_MARKED';
  if (doc?.checkInTime && !doc.checkOutTime) uiStatus = 'PRESENT';
  else if (doc?.checkOutTime) uiStatus = 'CHECKED_OUT';

  const base = doc ? doc.toObject() : { checkInTime: null, checkOutTime: null, status: null };
  return {
    ...base,
    canCheckIn,
    canCheckOut,
    uiStatus,
    pstDate: ymd
  };
};

const dashboardLabel = (rec) => {
  if (!rec) return 'NOT_MARKED';
  if (rec.status === ATTENDANCE_STATUS.LEAVE) return 'LEAVE';
  return rec.status;
};

const listToday = async (companyId) => {
  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);

  const users = await User.find({
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  })
    .select('name role')
    .sort({ name: 1 })
    .lean();

  const recs = await Attendance.find({
    companyId,
    date: dateDoc,
    isDeleted: { $ne: true }
  }).lean();

  const byEmp = new Map(recs.map((r) => [r.employeeId.toString(), r]));

  const employees = users.map((u) => {
    const r = byEmp.get(u._id.toString());
    const status = dashboardLabel(r);
    const hasCheckedOut = Boolean(r?.checkOutTime);
    return {
      employeeId: u._id,
      name: u.name,
      role: u.role,
      status,
      checkInTime: formatHmPst(r?.checkInTime),
      checkOutTime: formatHmPst(r?.checkOutTime),
      hasCheckedOut
    };
  });

  let present = 0;
  let notMarked = 0;
  let absent = 0;
  let halfDay = 0;
  let leave = 0;

  for (const e of employees) {
    if (e.status === 'NOT_MARKED') {
      notMarked += 1;
      absent += 1;
    } else if (e.status === ATTENDANCE_STATUS.PRESENT) present += 1;
    else if (e.status === ATTENDANCE_STATUS.ABSENT) absent += 1;
    else if (e.status === ATTENDANCE_STATUS.HALF_DAY) halfDay += 1;
    else if (e.status === ATTENDANCE_STATUS.LEAVE) leave += 1;
  }

  const distribution = {
    Present: present,
    Absent: absent,
    'Half-Day': halfDay,
    Leave: leave
  };

  return {
    employees: employees.map((e) => ({
      employeeId: e.employeeId.toString(),
      name: e.name,
      status: e.status,
      checkInTime: e.checkInTime,
      checkOutTime: e.checkOutTime,
      hasCheckedOut: e.hasCheckedOut
    })),
    summary: {
      present,
      notMarked,
      totalEmployees: employees.length
    },
    distribution
  };
};

const getMonthStatsForPayroll = async (companyId, employeeId, monthStr, asOfDate = new Date()) => {
  const [Y, M] = monthStr.split('-').map(Number);
  if (!Y || !M || M < 1 || M > 12) throw new ApiError(400, 'Invalid month (use YYYY-MM)');

  const ymds = pstMonthYmds(monthStr);
  if (!ymds.length) throw new ApiError(400, 'Invalid month');

  const ymdSet = new Set(ymds);
  const monthStartPst = DateTime.fromObject({ year: Y, month: M, day: 1 }, { zone: TZ }).startOf('month');
  const monthEndPst = monthStartPst.endOf('month');
  /** Widen range so legacy/manual rows (e.g. UTC midnight) are returned; we filter by Pacific YMD below. */
  const rangeStart = monthStartPst.minus({ days: 2 }).startOf('day').toUTC().toJSDate();
  const rangeEnd = monthEndPst.plus({ days: 2 }).endOf('day').toUTC().toJSDate();

  const candidates = await Attendance.find({
    companyId,
    employeeId,
    date: { $gte: rangeStart, $lte: rangeEnd },
    isDeleted: { $ne: true }
  }).lean();

  const byYmd = new Map();
  for (const r of candidates) {
    const k = pstYmdFromJsDate(r.date);
    if (ymdSet.has(k)) byYmd.set(k, r);
  }

  const todayPst = DateTime.fromJSDate(asOfDate).setZone(TZ).startOf('day');
  const monthLastPst = monthStartPst.endOf('month').startOf('day');
  const eligibleThrough = todayPst < monthLastPst ? todayPst : monthLastPst;

  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;

  for (const ymd of ymds) {
    const dayPst = DateTime.fromISO(ymd, { zone: TZ }).startOf('day');
    if (dayPst > eligibleThrough) break;

    const rec = byYmd.get(ymd);
    if (!rec) {
      absentDays += 1;
      continue;
    }
    switch (rec.status) {
      case ATTENDANCE_STATUS.PRESENT:
        presentDays += 1;
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
    monthStart: dateDocFromPstYmd(ymds[0]),
    monthEnd: dateDocFromPstYmd(ymds[ymds.length - 1])
  };
};

const runAutoCheckoutPst = async () => {
  const ymd = DateTime.now().setZone(TZ).minus({ days: 1 }).toISODate();
  const end = endOfPstDayJsDate(ymd);
  const dateDoc = dateDocFromPstYmd(ymd);

  const res = await Attendance.updateMany(
    {
      date: dateDoc,
      status: ATTENDANCE_STATUS.PRESENT,
      checkInTime: { $ne: null },
      $or: [{ checkOutTime: null }, { checkOutTime: { $exists: false } }],
      isDeleted: { $ne: true }
    },
    { $set: { checkOutTime: end } }
  );

  return res.modifiedCount ?? 0;
};

const report = async (companyId, query) => {
  const { employeeId, startDate, endDate } = query;
  if (!employeeId || !startDate || !endDate) {
    throw new ApiError(400, 'employeeId, startDate, and endDate are required');
  }

  const startYmd = DateTime.fromJSDate(new Date(startDate)).setZone(TZ).toISODate();
  const endYmd = DateTime.fromJSDate(new Date(endDate)).setZone(TZ).toISODate();

  let cur = DateTime.fromISO(startYmd, { zone: TZ }).startOf('day');
  const end = DateTime.fromISO(endYmd, { zone: TZ }).startOf('day');
  if (cur > end) throw new ApiError(400, 'startDate must be before endDate');

  const ymds = [];
  while (cur <= end) {
    ymds.push(cur.toISODate());
    cur = cur.plus({ days: 1 });
  }

  const ymdSet = new Set(ymds);
  const startDt = DateTime.fromISO(startYmd, { zone: TZ }).startOf('day');
  const endDt = DateTime.fromISO(endYmd, { zone: TZ }).startOf('day');
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

  const records = candidates.filter((r) => ymdSet.has(pstYmdFromJsDate(r.date)));

  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let leaveDays = 0;

  for (const r of records) {
    switch (r.status) {
      case ATTENDANCE_STATUS.PRESENT:
        presentDays += 1;
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
  }

  const sa = DateTime.fromISO(startYmd, { zone: TZ }).toMillis();
  const sb = DateTime.fromISO(endYmd, { zone: TZ }).toMillis();
  const totalDays = Math.floor((sb - sa) / 86400000) + 1;

  return {
    records,
    summary: {
      totalDays,
      presentDays,
      absentDays,
      halfDays,
      leaveDays
    }
  };
};

/**
 * Admin-only: set today's attendance status for an employee (Pacific calendar day).
 * Creates a row if none exists. PRESENT sets check-in time when missing; other statuses clear times.
 */
const adminSetAttendanceToday = async (companyId, targetEmployeeId, status) => {
  if (!Object.values(ATTENDANCE_STATUS).includes(status)) {
    throw new ApiError(400, 'Invalid attendance status');
  }

  const ymd = pstTodayYmd();
  const dateDoc = dateDocFromPstYmd(ymd);

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

  const stampLine = (verb) =>
    `Admin ${verb} ${status} — ${new Date().toISOString()}`;

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
      base.checkInTime = new Date();
      base.checkOutTime = null;
    } else {
      base.checkInTime = null;
      base.checkOutTime = null;
    }
    doc = await Attendance.create(base);
    return doc;
  }

  doc.status = status;
  doc.markedBy = ATTENDANCE_MARKED_BY.ADMIN;

  switch (status) {
    case ATTENDANCE_STATUS.PRESENT:
      if (!doc.checkInTime) doc.checkInTime = new Date();
      doc.checkOutTime = null;
      break;
    case ATTENDANCE_STATUS.ABSENT:
    case ATTENDANCE_STATUS.HALF_DAY:
    case ATTENDANCE_STATUS.LEAVE:
      doc.checkInTime = null;
      doc.checkOutTime = null;
      break;
    default:
      break;
  }

  const line = stampLine('updated');
  doc.notes = doc.notes ? `${doc.notes}\n${line}` : line;
  await doc.save();
  return doc;
};

/** @deprecated use adminSetAttendanceToday(..., ABSENT) — kept for existing clients */
const adminMarkAbsentToday = async (companyId, targetEmployeeId) => {
  return adminSetAttendanceToday(companyId, targetEmployeeId, ATTENDANCE_STATUS.ABSENT);
};

const monthlySummary = async (companyId, employeeId, monthStr, dailyAllowanceRate) => {
  const stats = await getMonthStatsForPayroll(companyId, employeeId, monthStr, new Date());
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

/**
 * Visit execution: require attendance record with status PRESENT on the same Pacific calendar day as the visit.
 * @param {import('mongoose').Types.ObjectId|string} companyId
 * @param {import('mongoose').Types.ObjectId|string} employeeId
 * @param {Date|string} visitDateInput — Date or YYYY-MM-DD
 */
const assertEmployeePresentForVisitDate = async (companyId, employeeId, visitDateInput) => {
  let ymd;
  if (typeof visitDateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visitDateInput)) {
    ymd = visitDateInput;
  } else {
    ymd = pstYmdFromJsDate(new Date(visitDateInput));
  }
  const dateDoc = dateDocFromPstYmd(ymd);
  const rec = await Attendance.findOne({
    companyId,
    employeeId,
    date: dateDoc,
    isDeleted: { $ne: true }
  });
  if (!rec || rec.status !== ATTENDANCE_STATUS.PRESENT) {
    throw new ApiError(400, 'Attendance must be PRESENT on the visit date to log this visit');
  }
  return rec;
};

module.exports = {
  assertEmployeePresentForVisitDate,
  monthBounds: (monthStr) => {
    const ymds = pstMonthYmds(monthStr);
    if (!ymds.length) throw new ApiError(400, 'Invalid month (use YYYY-MM)');
    const start = dateDocFromPstYmd(ymds[0]);
    const end = dateDocFromPstYmd(ymds[ymds.length - 1]);
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
  runAutoCheckoutPst,
  round2
};
