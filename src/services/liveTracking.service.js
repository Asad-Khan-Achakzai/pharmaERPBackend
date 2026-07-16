const AttendanceHeartbeat = require('../models/AttendanceHeartbeat');
const RepLocationSnapshot = require('../geo/models/RepLocationSnapshot');
const Attendance = require('../models/Attendance');
const Company = require('../models/Company');
const User = require('../models/User');
const mongoose = require('mongoose');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const { LATE_CHECKIN_APPROVAL_STATUS } = require('../constants/enums');
const businessTime = require('../utils/businessTime');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { resolveGeoPlatform } = require('../geo/utils/geoPlatformResolver');
const { assertHeartbeatRateLimit } = require('../utils/heartbeatRateLimit');
const {
  resolveAccuracyPolicy,
  classifyGpsQuality
} = require('../geo/utils/gpsQuality');

const todayYmd = (tz) => businessTime.nowInBusinessTime(tz).toISODate();
const dateDocFromYmd = (ymd, tz) => businessTime.businessDayStartUtc(ymd, tz);

const nd = { isDeleted: { $ne: true } };
const DEFAULT_STALE_MS = 30 * 60 * 1000;

async function assertLiveTrackingEnabled(companyId) {
  const company = await Company.findById(companyId).select('liveTrackingEnabled geoPlatform').lean();
  if (!company) {
    throw new ApiError(404, 'Company not found');
  }
  if (company.liveTrackingEnabled === true) return company;
  const geo = resolveGeoPlatform(company);
  if (geo.enabled && geo.features.liveTracking === true) return company;
  throw new ApiError(403, 'Live tracking is not enabled for this company');
}

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

async function recordHeartbeat({
  companyId,
  userId,
  timeZone,
  lat,
  lng,
  accuracy,
  capturedAt,
  clientUuid,
  company,
  confidence,
  speed,
  heading,
  trackingContext,
  expectedNextPingMs,
  source,
  battery,
  skipRateLimit = false
}) {
  await assertLiveTrackingEnabled(companyId);

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new ApiError(400, 'lat and lng are required');
  }

  if (clientUuid) {
    const existing = await AttendanceHeartbeat.findOne({ companyId, userId, clientUuid }).lean();
    if (existing) return existing;
  }

  const captured = capturedAt ? new Date(capturedAt) : new Date();
  if (!skipRateLimit) {
    await assertHeartbeatRateLimit(companyId, userId, { capturedAt: captured });
  }

  const geo = resolveGeoPlatform(company);
  const policy = resolveAccuracyPolicy(geo.liveTracking || {});
  const classified = classifyGpsQuality(accuracy, policy);

  if (!classified.retainForHistory) {
    const err = new ApiError(
      422,
      `Location accuracy too low for route history (>${policy.historyMaxAccuracyMeters}m)`
    );
    err.code = 'GPS_ACCURACY_INVALID';
    err.data = {
      qualityLevel: 'invalid',
      usableForLive: false,
      historyMaxAccuracyMeters: policy.historyMaxAccuracyMeters
    };
    throw err;
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
    confidence: confidence ?? null,
    qualityLevel: classified.qualityLevel,
    usableForLive: classified.usableForLive,
    speed: speed ?? null,
    heading: heading ?? null,
    trackingContext: trackingContext || null,
    expectedNextPingMs: expectedNextPingMs ?? null,
    capturedAt: captured,
    clientUuid: clientUuid || null
  };
  if (source) payload.source = source;
  if (battery != null && Number.isFinite(Number(battery))) payload.battery = Number(battery);

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

function pickBestLocationFix(snapshot, heartbeat) {
  // Prefer snapshot (only updated for live-eligible points). Ignore history-only heartbeats for live pin.
  const liveHeartbeat =
    heartbeat && heartbeat.usableForLive !== false ? heartbeat : null;
  if (snapshot && liveHeartbeat) {
    const snapAt = new Date(snapshot.capturedAt).getTime();
    const beatAt = new Date(liveHeartbeat.capturedAt).getTime();
    if (beatAt !== snapAt) return beatAt > snapAt ? liveHeartbeat : snapshot;
    const snapUploaded = snapshot.uploadedAt ? new Date(snapshot.uploadedAt).getTime() : snapAt;
    return beatAt >= snapUploaded ? liveHeartbeat : snapshot;
  }
  return snapshot || liveHeartbeat || null;
}

function pickLocationFields(snapshot, heartbeat, attendance, staleMs) {
  const source = pickBestLocationFix(snapshot, heartbeat);
  if (source) {
    const capturedAt = source.capturedAt;
    const ageSeconds = Math.round((Date.now() - new Date(capturedAt).getTime()) / 1000);
    if (ageSeconds * 1000 <= staleMs) {
      return {
        lat: source.lat,
        lng: source.lng,
        accuracy: source.accuracy,
        confidence: source.confidence ?? null,
        qualityLevel: source.qualityLevel ?? null,
        usableForLive: source.usableForLive !== false,
        speed: source.speed ?? null,
        heading: source.heading ?? null,
        trackingContext: source.trackingContext ?? null,
        expectedNextPingMs: source.expectedNextPingMs ?? null,
        capturedAt,
        ageSeconds,
        locationSource: snapshot ? 'snapshot' : 'heartbeat'
      };
    }
  }

  const checkInLat = attendance?.checkInLat;
  const checkInLng = attendance?.checkInLng;
  const checkInTime = attendance?.checkInTime;
  if (typeof checkInLat === 'number' && typeof checkInLng === 'number' && checkInTime) {
    return {
      lat: checkInLat,
      lng: checkInLng,
      accuracy: attendance.checkInAccuracy ?? null,
      confidence: 40,
      qualityLevel: 'acceptable',
      usableForLive: true,
      speed: null,
      heading: null,
      trackingContext: null,
      expectedNextPingMs: null,
      capturedAt: checkInTime,
      ageSeconds: Math.round((Date.now() - new Date(checkInTime).getTime()) / 1000),
      locationSource: 'checkin'
    };
  }

  return {
    lat: null,
    lng: null,
    accuracy: null,
    confidence: null,
    qualityLevel: null,
    usableForLive: null,
    speed: null,
    heading: null,
    trackingContext: null,
    expectedNextPingMs: null,
    capturedAt: null,
    ageSeconds: null,
    locationSource: null
  };
}

function buildLiveRow({ user, snapshot, heartbeat, attendance, staleMs }) {
  const attendanceStatus = resolveAttendanceStatus(attendance);
  const location = pickLocationFields(snapshot, heartbeat, attendance, staleMs);
  return {
    userId: user._id,
    name: user.name,
    attendanceStatus,
    checkInTime: attendance?.checkInTime ?? null,
    checkOutTime: attendance?.checkOutTime ?? null,
    ...location
  };
}

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

function computeEtag(rows) {
  const hash = crypto.createHash('sha1');
  hash.update(JSON.stringify(rows));
  return `"${hash.digest('hex')}"`;
}

async function listLive(companyId, reqUser, timeZone, company, query = {}) {
  await assertLiveTrackingEnabled(companyId);

  const geo = resolveGeoPlatform(company);
  const staleMs = geo.liveTracking?.staleDisplayMs ?? DEFAULT_STALE_MS;

  const teamUsers = await resolveLiveTrackingUserIds(companyId, reqUser);
  if (!teamUsers.length) return { rows: [], etag: computeEtag([]) };

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

  const since = new Date(Date.now() - staleMs);
  const [snapshotRows, heartbeatRows] = await Promise.all([
    RepLocationSnapshot.find({
      companyId: cid,
      userId: { $in: scopedIds },
      capturedAt: { $gte: since }
    }).lean(),
    AttendanceHeartbeat.aggregate([
      {
        $match: {
          companyId: cid,
          userId: { $in: scopedIds },
          capturedAt: { $gte: since },
          // Prefer live-eligible samples for the live map fallback
          usableForLive: { $ne: false }
        }
      },
      { $sort: { capturedAt: -1 } },
      {
        $group: {
          _id: '$userId',
          lat: { $first: '$lat' },
          lng: { $first: '$lng' },
          accuracy: { $first: '$accuracy' },
          confidence: { $first: '$confidence' },
          qualityLevel: { $first: '$qualityLevel' },
          usableForLive: { $first: '$usableForLive' },
          speed: { $first: '$speed' },
          heading: { $first: '$heading' },
          trackingContext: { $first: '$trackingContext' },
          expectedNextPingMs: { $first: '$expectedNextPingMs' },
          capturedAt: { $first: '$capturedAt' }
        }
      }
    ])
  ]);

  const snapshotByUser = new Map(snapshotRows.map((r) => [String(r.userId), r]));
  const heartbeatByUser = new Map(heartbeatRows.map((r) => [String(r._id), r]));

  const rows = sortLiveTrackingRows(
    teamUsers.map((u) =>
      buildLiveRow({
        user: u,
        snapshot: snapshotByUser.get(String(u._id)),
        heartbeat: heartbeatByUser.get(String(u._id)),
        attendance: attendanceByUser.get(String(u._id)),
        staleMs
      })
    )
  );

  const etag = computeEtag(rows);
  if (query.ifNoneMatch && query.ifNoneMatch === etag) {
    return { notModified: true, etag, rows };
  }

  return { rows, etag };
}

module.exports = {
  recordHeartbeat,
  listLive,
  computeEtag,
  pickBestLocationFix,
  pickLocationFields
};
