const AttendanceHeartbeat = require('../models/AttendanceHeartbeat');
const Attendance = require('../models/Attendance');
const Company = require('../models/Company');
const User = require('../models/User');
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { LATE_CHECKIN_APPROVAL_STATUS } = require('../constants/enums');
const businessTime = require('../utils/businessTime');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');

const todayYmd = (tz) => businessTime.nowInBusinessTime(tz).toISODate();
const dateDocFromYmd = (ymd, tz) => businessTime.businessDayStartUtc(ymd, tz);

const nd = { isDeleted: { $ne: true } };
const MAX_ACCURACY_METERS = 150;
const LIVE_STALE_MS = 30 * 60 * 1000;

async function assertLiveTrackingEnabled(companyId) {
  const company = await Company.findById(companyId).select('liveTrackingEnabled').lean();
  if (!company?.liveTrackingEnabled) {
    throw new ApiError(403, 'Live tracking is not enabled for this company');
  }
}

/** Open shift for heartbeat — uses company business day (same as check-in), not server local midnight. */
async function findOpenAttendanceForHeartbeat(companyId, employeeId, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = todayYmd(tz);
  const dateDoc = dateDocFromYmd(ymd, tz);
  const openQuery = {
    companyId,
    employeeId,
    checkInTime: { $ne: null },
    checkOutTime: null,
    ...nd
  };

  const today = await Attendance.findOne({ ...openQuery, date: dateDoc }).lean();
  if (today) return today;

  const prevYmd = businessTime.nowInBusinessTime(tz).minus({ days: 1 }).toISODate();
  const prevDoc = dateDocFromYmd(prevYmd, tz);
  return Attendance.findOne({ ...openQuery, date: prevDoc }).lean();
}

async function recordHeartbeat({ companyId, userId, timeZone, lat, lng, accuracy, capturedAt, clientUuid }) {
  await assertLiveTrackingEnabled(companyId);

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new ApiError(400, 'lat and lng are required');
  }
  if (accuracy != null && accuracy > MAX_ACCURACY_METERS) {
    throw new ApiError(422, `Location accuracy too low (>${MAX_ACCURACY_METERS}m)`);
  }

  const attendance = await findOpenAttendanceForHeartbeat(companyId, userId, timeZone);
  if (!attendance) {
    throw new ApiError(400, 'Check in before sending location updates');
  }

  const payload = {
    companyId,
    userId,
    lat,
    lng,
    accuracy: accuracy ?? null,
    capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
    clientUuid: clientUuid || null
  };

  if (clientUuid) {
    const existing = await AttendanceHeartbeat.findOne({ companyId, userId, clientUuid }).lean();
    if (existing) return existing;
  }

  try {
    const doc = await AttendanceHeartbeat.create(payload);
    return doc.toObject();
  } catch (err) {
    if (err.code === 11000 && clientUuid) {
      const existing = await AttendanceHeartbeat.findOne({ companyId, userId, clientUuid }).lean();
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Users visible on the live map — mirrors GET /users/team scope:
 * - Tenant admin: all active company users except the viewer
 * - Managers: full reporting subtree (descendants), excluding the viewer
 */
async function resolveLiveTrackingUserIds(companyId, reqUser) {
  const viewerId = new mongoose.Types.ObjectId(String(reqUser.userId));
  const cid = new mongoose.Types.ObjectId(String(companyId));

  if (userHasTenantWideAccess(reqUser)) {
    return User.find({
      companyId: cid,
      isActive: true,
      _id: { $ne: viewerId },
      ...nd
    })
      .select('_id name email')
      .sort({ name: 1 })
      .lean();
  }

  let subtreeIds = await resolveSubtreeUserIds(cid, viewerId, {
    includeSelf: false,
    activeOnly: true
  });
  subtreeIds = subtreeIds.filter((id) => String(id) !== String(viewerId));
  if (!subtreeIds.length) return [];

  return User.find({ _id: { $in: subtreeIds }, companyId: cid, isActive: true, ...nd })
    .select('_id name email')
    .sort({ name: 1 })
    .lean();
}

function resolveAttendanceStatus(attendance) {
  if (!attendance?.checkInTime) return 'NOT_CHECKED_IN';
  if (attendance.lateCheckInApprovalStatus === LATE_CHECKIN_APPROVAL_STATUS.PENDING) {
    return 'LATE_CHECKIN_PENDING';
  }
  if (attendance.checkOutTime) return 'CHECKED_OUT';
  return 'CHECKED_IN';
}

function pickLocationFields(heartbeat, attendance) {
  if (heartbeat) {
    return {
      lat: heartbeat.lat,
      lng: heartbeat.lng,
      accuracy: heartbeat.accuracy,
      capturedAt: heartbeat.capturedAt,
      ageSeconds: Math.round((Date.now() - new Date(heartbeat.capturedAt).getTime()) / 1000),
      locationSource: 'heartbeat'
    };
  }

  const checkInLat = attendance?.checkInLat;
  const checkInLng = attendance?.checkInLng;
  const checkInTime = attendance?.checkInTime;
  if (typeof checkInLat === 'number' && typeof checkInLng === 'number' && checkInTime) {
    return {
      lat: checkInLat,
      lng: checkInLng,
      accuracy: attendance.checkInAccuracy ?? null,
      capturedAt: checkInTime,
      ageSeconds: Math.round((Date.now() - new Date(checkInTime).getTime()) / 1000),
      locationSource: 'checkin'
    };
  }

  return {
    lat: null,
    lng: null,
    accuracy: null,
    capturedAt: null,
    ageSeconds: null,
    locationSource: null
  };
}

function buildLiveRow({ user, heartbeat, attendance }) {
  const attendanceStatus = resolveAttendanceStatus(attendance);
  const location = pickLocationFields(heartbeat, attendance);
  return {
    userId: user._id,
    name: user.name,
    attendanceStatus,
    checkInTime: attendance?.checkInTime ?? null,
    checkOutTime: attendance?.checkOutTime ?? null,
    ...location
  };
}

/** Located users first (most recent ping on top); others alphabetically at the bottom. */
function sortLiveTrackingRows(rows) {
  return [...rows].sort((a, b) => {
    const aLocated = a.capturedAt != null && a.ageSeconds != null;
    const bLocated = b.capturedAt != null && b.ageSeconds != null;
    if (aLocated !== bLocated) return aLocated ? -1 : 1;
    if (aLocated && bLocated) {
      const ageDiff = a.ageSeconds - b.ageSeconds;
      if (ageDiff !== 0) return ageDiff;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
}

async function listLive(companyId, reqUser, timeZone, query = {}) {
  await assertLiveTrackingEnabled(companyId);

  const teamUsers = await resolveLiveTrackingUserIds(companyId, reqUser);
  if (!teamUsers.length) return [];

  const cid = new mongoose.Types.ObjectId(String(companyId));
  const scopedIds = teamUsers.map((u) => u._id);
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateDoc = dateDocFromYmd(todayYmd(tz), tz);

  const attendanceRows = await Attendance.find({
    companyId: cid,
    employeeId: { $in: scopedIds },
    date: dateDoc,
    ...nd
  })
    .select(
      'employeeId checkInTime checkOutTime lateCheckInApprovalStatus checkInLat checkInLng checkInAccuracy'
    )
    .lean();
  const attendanceByUser = new Map(attendanceRows.map((r) => [String(r.employeeId), r]));

  const since = new Date(Date.now() - LIVE_STALE_MS);
  const heartbeatRows = await AttendanceHeartbeat.aggregate([
    {
      $match: {
        companyId: cid,
        userId: { $in: scopedIds },
        capturedAt: { $gte: since }
      }
    },
    { $sort: { capturedAt: -1 } },
    {
      $group: {
        _id: '$userId',
        lat: { $first: '$lat' },
        lng: { $first: '$lng' },
        accuracy: { $first: '$accuracy' },
        capturedAt: { $first: '$capturedAt' }
      }
    }
  ]);
  const heartbeatByUser = new Map(heartbeatRows.map((r) => [String(r._id), r]));

  return sortLiveTrackingRows(
    teamUsers.map((u) =>
      buildLiveRow({
        user: u,
        heartbeat: heartbeatByUser.get(String(u._id)),
        attendance: attendanceByUser.get(String(u._id))
      })
    )
  );
}

module.exports = { recordHeartbeat, listLive, MAX_ACCURACY_METERS };
