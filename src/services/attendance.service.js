const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { ATTENDANCE_STATUS, ATTENDANCE_MARKED_BY } = require('../constants/enums');
const businessTime = require('../utils/businessTime');

const round2 = (n) => Math.round(n * 100) / 100;

/** Earliest check-in on the business calendar day (0 = any time that day). */
const CHECK_IN_FROM_MINUTES = 0;

const todayYmd = (tz) => businessTime.nowInBusinessTime(tz).toISODate();
const dateDocFromYmd = (ymd, tz) => businessTime.businessDayStartUtc(ymd, tz);

const parseJsDateFromBody = (raw) => {
  if (raw instanceof Date) return raw;
  const dt = DateTime.fromISO(String(raw), { zone: 'utc' });
  if (!dt.isValid) throw new ApiError(400, 'Invalid date');
  return dt.toJSDate();
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

const checkIn = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const user = await User.findOne({
    _id: employeeId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  });
  if (!user) throw new ApiError(403, 'Active employee not found');

  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  const mins = businessTime.businessMinutesSinceMidnight(tz);

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
    throw new ApiError(400, 'Already checked in today');
  }

  const now = businessTime.utcNow();
  return Attendance.create({
    companyId,
    employeeId,
    date: dateDoc,
    status: ATTENDANCE_STATUS.PRESENT,
    checkInTime: now,
    markedBy: ATTENDANCE_MARKED_BY.SELF
  });
};

const checkOut = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
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

  rec.checkOutTime = businessTime.utcNow();
  await rec.save();
  return rec;
};

const markSelf = async (companyId, employeeId, body = {}, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const existing = await findTodayRecord(companyId, employeeId, tz);
  if (!existing) {
    return checkIn(companyId, employeeId, tz);
  }
  if (body.checkOutTime !== undefined) {
    existing.checkOutTime = parseJsDateFromBody(body.checkOutTime);
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

const getMeToday = async (companyId, employeeId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
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

  const mins = businessTime.businessMinutesSinceMidnight(tz);
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
    businessDate: ymd,
    pstDate: ymd
  };
};

const dashboardLabel = (rec) => {
  if (!rec) return 'NOT_MARKED';
  if (rec.status === ATTENDANCE_STATUS.LEAVE) return 'LEAVE';
  return rec.status;
};

const listToday = async (companyId, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);

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
      checkInTime: businessTime.formatHmBusiness(r?.checkInTime, tz),
      checkOutTime: businessTime.formatHmBusiness(r?.checkOutTime, tz),
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
      $or: [{ checkOutTime: null }, { checkOutTime: { $exists: false } }],
      isDeleted: { $ne: true }
    },
    { $set: { checkOutTime: end } }
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
  const { employeeId, startDate, endDate } = query;
  if (!employeeId || !startDate || !endDate) {
    throw new ApiError(400, 'employeeId, startDate, and endDate are required');
  }

  const toYmd = (raw) => {
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

  const sa = DateTime.fromISO(startYmd, { zone: tz }).toMillis();
  const sb = DateTime.fromISO(endYmd, { zone: tz }).toMillis();
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

const adminSetAttendanceToday = async (companyId, targetEmployeeId, status, timeZone) => {
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
      if (!doc.checkInTime) doc.checkInTime = businessTime.utcNow();
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

const adminMarkAbsentToday = async (companyId, targetEmployeeId, timeZone) => {
  return adminSetAttendanceToday(companyId, targetEmployeeId, ATTENDANCE_STATUS.ABSENT, timeZone);
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
  if (!rec || rec.status !== ATTENDANCE_STATUS.PRESENT) {
    throw new ApiError(400, 'Attendance must be PRESENT on the visit date to log this visit');
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
