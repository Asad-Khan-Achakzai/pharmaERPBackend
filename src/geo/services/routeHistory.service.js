const mongoose = require('mongoose');
const AttendanceHeartbeat = require('../../models/AttendanceHeartbeat');
const Attendance = require('../../models/Attendance');
const VisitLog = require('../../models/VisitLog');
const TrackingDiagnostic = require('../../models/TrackingDiagnostic');
const Doctor = require('../../models/Doctor');
const Pharmacy = require('../../models/Pharmacy');
const CallPoint = require('../../models/CallPoint');
const Order = require('../../models/Order');
const MediaAsset = require('../../models/MediaAsset');
const User = require('../../models/User');
const { DateTime } = require('luxon');
const businessTime = require('../../utils/businessTime');
const { haversineMeters } = require('../../utils/haversine');
const { resolveGeoPlatform } = require('../utils/geoPlatformResolver');
const dayRouteService = require('./dayRoute.service');
const { PLAN_ITEM_STATUS } = require('../../constants/enums');

const nd = { isDeleted: { $ne: true } };

const STOP_DWELL_MS = 5 * 60 * 1000;
const STOP_RADIUS_M = 75;
const ENTITY_PROXIMITY_M = 100;
const MIN_GAP_FLOOR_MS = 5 * 60 * 1000;
const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_PATH_POINTS = 500;
const GAP_DIAGNOSTIC_TYPES = new Set([
  'GPS_DISABLED',
  'GPS_UNAVAILABLE',
  'BACKGROUND_SERVICE_FAILED',
  'OFFLINE',
  'NETWORK_UNAVAILABLE',
  'PERMISSION_CHANGED',
  'LOW_BATTERY',
  'DEVICE_RESTART'
]);

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function downsamplePath(path, maxPoints) {
  if (!maxPoints || path.length <= maxPoints) return path;
  if (maxPoints < 2) return path.slice(0, 1);
  const result = [path[0]];
  const step = (path.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i += 1) {
    result.push(path[Math.round(i * step)]);
  }
  result.push(path[path.length - 1]);
  return result;
}

function pathDistanceMeters(path) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += haversineMeters(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
  }
  return total;
}

function detectGaps(path, expectedSampleIntervalMs, diagnostics) {
  const threshold = Math.max(3 * expectedSampleIntervalMs, MIN_GAP_FLOOR_MS);
  const gaps = [];

  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const curr = path[i];
    const gapMs = new Date(curr.capturedAt).getTime() - new Date(prev.capturedAt).getTime();
    if (gapMs > threshold) {
      gaps.push({
        type: 'SIGNAL_GAP',
        from: prev.capturedAt,
        to: curr.capturedAt,
        durationMs: gapMs,
        fromLat: prev.lat,
        fromLng: prev.lng,
        toLat: curr.lat,
        toLng: curr.lng
      });
    }
  }

  for (const d of diagnostics) {
    if (!GAP_DIAGNOSTIC_TYPES.has(d.type)) continue;
    gaps.push({
      type: d.type,
      from: d.capturedAt,
      to: d.capturedAt,
      durationMs: 0,
      fromLat: null,
      fromLng: null,
      toLat: null,
      toLng: null,
      meta: d.meta || {}
    });
  }

  return gaps.sort((a, b) => new Date(a.from) - new Date(b.from));
}

function detectStops(path) {
  if (path.length < 2) return [];
  const stops = [];
  let clusterStart = 0;

  for (let i = 1; i <= path.length; i += 1) {
    const done = i === path.length;
    const anchor = path[clusterStart];
    const curr = done ? null : path[i];
    const drifted =
      curr && haversineMeters(anchor.lat, anchor.lng, curr.lat, curr.lng) > STOP_RADIUS_M;

    if (done || drifted) {
      const endIdx = i - 1;
      const startPt = path[clusterStart];
      const endPt = path[endIdx];
      const durationMs =
        new Date(endPt.capturedAt).getTime() - new Date(startPt.capturedAt).getTime();
      if (durationMs >= STOP_DWELL_MS) {
        let latSum = 0;
        let lngSum = 0;
        const count = endIdx - clusterStart + 1;
        for (let j = clusterStart; j <= endIdx; j += 1) {
          latSum += path[j].lat;
          lngSum += path[j].lng;
        }
        stops.push({
          lat: latSum / count,
          lng: lngSum / count,
          startedAt: startPt.capturedAt,
          endedAt: endPt.capturedAt,
          durationMs,
          classification: 'Unknown Stop',
          entityId: null,
          entityName: null,
          visitLogId: null
        });
      }
      clusterStart = i;
    }
  }

  return stops;
}

function classifyStop(stop, visits, doctors, pharmacies, callPoints) {
  const stopStart = new Date(stop.startedAt).getTime();
  const stopEnd = new Date(stop.endedAt).getTime();

  for (const v of visits) {
    const vt = new Date(v.at || v.visitTime || v.createdAt).getTime();
    if (vt >= stopStart - 2 * 60 * 1000 && vt <= stopEnd + 2 * 60 * 1000) {
      if (v.doctorId) {
        const doc = doctors.find((d) => String(d._id) === String(v.doctorId));
        return {
          ...stop,
          classification: 'Doctor Visit',
          entityId: v.doctorId,
          entityName: doc?.name || null,
          visitLogId: v.id || v._id || null
        };
      }
    }
  }

  let best = { kind: null, dist: Infinity, entity: null };
  for (const d of doctors) {
    if (typeof d.latitude !== 'number' || typeof d.longitude !== 'number') continue;
    const dist = haversineMeters(stop.lat, stop.lng, d.latitude, d.longitude);
    if (dist <= ENTITY_PROXIMITY_M && dist < best.dist) {
      best = { kind: 'Doctor Visit', dist, entity: d };
    }
  }
  for (const p of pharmacies) {
    if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number') continue;
    const dist = haversineMeters(stop.lat, stop.lng, p.latitude, p.longitude);
    if (dist <= ENTITY_PROXIMITY_M && dist < best.dist) {
      best = { kind: 'Pharmacy Visit', dist, entity: p };
    }
  }
  for (const cp of callPoints) {
    if (typeof cp.latitude !== 'number' || typeof cp.longitude !== 'number') continue;
    const dist = haversineMeters(stop.lat, stop.lng, cp.latitude, cp.longitude);
    if (dist <= ENTITY_PROXIMITY_M && dist < best.dist) {
      best = { kind: 'Call Point', dist, entity: cp };
    }
  }

  if (best.kind) {
    return {
      ...stop,
      classification: best.kind,
      entityId: best.entity._id,
      entityName: best.entity.name || null
    };
  }

  if (stop.durationMs >= STOP_DWELL_MS) {
    return { ...stop, classification: 'Idle Stop' };
  }
  return stop;
}

function buildQuality({ path, gaps, expectedSampleIntervalMs, diagnostics, workingHoursMs }) {
  const reasons = [];
  const accuracies = path.map((p) => p.accuracy).filter((a) => typeof a === 'number');
  const medianAccuracy = median(accuracies);
  const gapMinutes = gaps
    .filter((g) => g.type === 'SIGNAL_GAP')
    .reduce((sum, g) => sum + g.durationMs, 0) / 60000;

  const expectedPings =
    workingHoursMs > 0 ? Math.max(1, Math.floor(workingHoursMs / expectedSampleIntervalMs)) : path.length || 1;
  const completenessRatio = Math.min(1, path.length / expectedPings);

  let score = Math.round(completenessRatio * 70);
  if (medianAccuracy != null) {
    if (medianAccuracy <= 50) score += 20;
    else if (medianAccuracy <= 100) score += 12;
    else if (medianAccuracy <= 150) score += 6;
    else reasons.push('Poor GPS accuracy');
  } else if (path.length) {
    reasons.push('Missing accuracy metadata');
  }

  if (gapMinutes > 30) {
    score -= 20;
    reasons.push('Large tracking gaps');
  } else if (gapMinutes > 10) {
    score -= 10;
    reasons.push('Moderate tracking gaps');
  }

  const bgFail = diagnostics.some((d) => d.type === 'BACKGROUND_SERVICE_FAILED');
  const gpsDisabled = diagnostics.some((d) => d.type === 'GPS_DISABLED' || d.type === 'GPS_UNAVAILABLE');
  const offline = diagnostics.some((d) => d.type === 'OFFLINE' || d.type === 'NETWORK_UNAVAILABLE');

  let backgroundHealthHint = 'ok';
  if (bgFail) {
    backgroundHealthHint = 'background_failed';
    score -= 15;
    reasons.push('Background service failures');
  } else if (gpsDisabled) {
    backgroundHealthHint = 'gps_disabled';
    score -= 10;
    reasons.push('GPS disabled during shift');
  } else if (offline) {
    backgroundHealthHint = 'offline_periods';
    reasons.push('Offline periods detected');
  }

  if (!path.length) {
    score = 0;
    reasons.push('No location path recorded');
  }

  score = Math.max(0, Math.min(100, score));
  let band = 'Trusted';
  if (score < 40) band = 'Unreliable';
  else if (score < 70) band = 'Partial';

  return {
    score,
    band,
    reasons,
    completenessRatio: Math.round(completenessRatio * 1000) / 1000,
    gapMinutes: Math.round(gapMinutes * 10) / 10,
    medianAccuracy: medianAccuracy != null ? Math.round(medianAccuracy) : null,
    backgroundHealthHint
  };
}

function emptySummary() {
  return {
    workingHoursMs: 0,
    distanceMeters: 0,
    drivingTimeMs: 0,
    visitTimeMs: 0,
    idleTimeMs: 0,
    visitCount: 0,
    orderCount: 0,
    doctorsVisited: 0,
    pharmaciesVisited: 0,
    plannedCompleted: 0,
    plannedMissed: 0,
    unplannedVisits: 0,
    coveragePercent: 0,
    productiveTimeMs: 0,
    nonProductiveTimeMs: 0
  };
}

/**
 * Full-day Route History payload for one employee.
 * @param {string|ObjectId} companyId
 * @param {string|ObjectId} userId
 * @param {string} [dateYmd]
 * @param {string} timeZone
 * @param {{ downsample?: boolean, maxPoints?: number, company?: object, summaryOnly?: boolean }} [options]
 */
async function getRouteHistory(companyId, userId, dateYmd, timeZone, options = {}) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = dateYmd || businessTime.nowInBusinessTime(tz).toISODate();
  const range = businessTime.businessDayToUtcRange(ymd, tz);
  const start = range.$gte;
  const end = range.$lte;
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const uid = new mongoose.Types.ObjectId(String(userId));

  const geo = resolveGeoPlatform(options.company);
  const expectedSampleIntervalMs =
    geo.liveTracking?.sampleIntervalMs || DEFAULT_SAMPLE_INTERVAL_MS;

  const [heartbeats, attendance, visitLogs, diagnostics, plannedRoute, orders, user] =
    await Promise.all([
      AttendanceHeartbeat.find({
        companyId: cid,
        userId: uid,
        capturedAt: { $gte: start, $lte: end }
      })
        .sort({ capturedAt: 1 })
        .select('lat lng accuracy speed heading source capturedAt')
        .lean(),
      Attendance.findOne({ companyId: cid, employeeId: uid, date: dateDoc, ...nd })
        .select('checkInLat checkInLng checkInTime checkOutLat checkOutLng checkOutTime')
        .lean(),
      VisitLog.find({
        companyId: cid,
        employeeId: uid,
        $or: [
          { visitTime: { $gte: start, $lte: end } },
          { createdAt: { $gte: start, $lte: end } }
        ],
        ...nd
      })
        .sort({ visitTime: 1, createdAt: 1 })
        .select(
          'location createdAt visitTime checkInTime checkOutTime doctorId distanceFromDoctor geoFenceResult notes orderTaken planItemId'
        )
        .lean(),
      TrackingDiagnostic.find({
        companyId: cid,
        userId: uid,
        capturedAt: { $gte: start, $lte: end }
      })
        .sort({ capturedAt: 1 })
        .lean(),
      dayRouteService.getDayRoute(companyId, userId, ymd, timeZone).catch(() => null),
      Order.find({
        companyId: cid,
        medicalRepId: uid,
        createdAt: { $gte: start, $lte: end },
        ...nd
      })
        .select('_id createdAt visitLogId pharmacyId doctorId')
        .lean(),
      User.findOne({ _id: uid, companyId: cid, ...nd }).select('territoryId').lean()
    ]);

  const visitIds = visitLogs.map((v) => v._id);
  const photoCounts =
    visitIds.length > 0
      ? await MediaAsset.aggregate([
          {
            $match: {
              companyId: cid,
              kind: 'VISIT_PHOTO',
              'linkedTo.resource': 'visits',
              'linkedTo.id': { $in: visitIds },
              status: { $ne: 'DELETING' }
            }
          },
          { $group: { _id: '$linkedTo.id', count: { $sum: 1 } } }
        ])
      : [];
  const photosByVisit = new Map(photoCounts.map((r) => [String(r._id), r.count]));

  const doctorIds = [
    ...new Set(visitLogs.filter((v) => v.doctorId).map((v) => String(v.doctorId)))
  ];
  const [doctorsNear, pharmaciesNear, callPoints] = await Promise.all([
    Doctor.find({
      companyId: cid,
      ...(doctorIds.length ? { _id: { $in: doctorIds } } : { isActive: true }),
      latitude: { $type: 'number' },
      longitude: { $type: 'number' },
      ...nd
    })
      .select('name latitude longitude')
      .limit(doctorIds.length ? doctorIds.length + 50 : 500)
      .lean(),
    Pharmacy.find({
      companyId: cid,
      isActive: true,
      latitude: { $type: 'number' },
      longitude: { $type: 'number' },
      ...nd
    })
      .select('name latitude longitude')
      .limit(500)
      .lean(),
    CallPoint.find({ companyId: cid, isActive: true, ...nd })
      .select('name latitude longitude')
      .lean()
  ]);

  // Expand doctor set used for stop classification with nearby active doctors
  const allDoctorsForStops =
    doctorIds.length > 0
      ? await Doctor.find({
          companyId: cid,
          isActive: true,
          latitude: { $type: 'number' },
          longitude: { $type: 'number' },
          ...nd
        })
          .select('name latitude longitude')
          .limit(800)
          .lean()
      : doctorsNear;

  let path = heartbeats.map((h) => ({
    lat: h.lat,
    lng: h.lng,
    accuracy: h.accuracy ?? null,
    speed: h.speed ?? null,
    heading: h.heading ?? null,
    source: h.source ?? null,
    capturedAt: h.capturedAt,
    type: 'heartbeat'
  }));

  const maxPoints =
    options.maxPoints != null
      ? Number(options.maxPoints)
      : options.downsample
        ? DEFAULT_MAX_PATH_POINTS
        : null;
  if (maxPoints) {
    path = downsamplePath(path, maxPoints);
  }

  const visits = visitLogs.map((v) => {
    const at = v.visitTime || v.createdAt;
    const durationMs =
      v.checkInTime && v.checkOutTime
        ? Math.max(0, new Date(v.checkOutTime) - new Date(v.checkInTime))
        : null;
    const relatedOrders = orders.filter(
      (o) =>
        (o.visitLogId && String(o.visitLogId) === String(v._id)) ||
        (Math.abs(new Date(o.createdAt) - new Date(at)) <= 30 * 60 * 1000 &&
          (!o.doctorId || String(o.doctorId) === String(v.doctorId)))
    );
    return {
      id: v._id,
      lat: v.location?.lat ?? null,
      lng: v.location?.lng ?? null,
      at,
      visitTime: v.visitTime,
      checkInTime: v.checkInTime ?? null,
      checkOutTime: v.checkOutTime ?? null,
      durationMs,
      doctorId: v.doctorId,
      planItemId: v.planItemId,
      geoFenceResult: v.geoFenceResult,
      distanceFromDoctor: v.distanceFromDoctor,
      hasOrder: !!(v.orderTaken || relatedOrders.length),
      hasPhotos: (photosByVisit.get(String(v._id)) || 0) > 0,
      hasNotes: !!(v.notes && String(v.notes).trim()),
      orderIds: relatedOrders.map((o) => o._id)
    };
  });

  const gaps = detectGaps(path, expectedSampleIntervalMs, diagnostics);
  let stops = detectStops(path).map((s) =>
    classifyStop(s, visits, allDoctorsForStops, pharmaciesNear, callPoints)
  );

  const events = [];

  if (attendance?.checkInTime) {
    events.push({
      type: 'CHECK_IN',
      at: attendance.checkInTime,
      lat: attendance.checkInLat ?? null,
      lng: attendance.checkInLng ?? null
    });
  }
  if (attendance?.checkOutTime) {
    events.push({
      type: 'CHECK_OUT',
      at: attendance.checkOutTime,
      lat: attendance.checkOutLat ?? null,
      lng: attendance.checkOutLng ?? null
    });
  }

  for (const v of visits) {
    events.push({
      type: 'VISIT',
      at: v.at,
      lat: v.lat,
      lng: v.lng,
      visitLogId: v.id,
      doctorId: v.doctorId,
      geoFenceResult: v.geoFenceResult
    });
  }

  for (const o of orders) {
    events.push({
      type: 'ORDER',
      at: o.createdAt,
      orderId: o._id,
      pharmacyId: o.pharmacyId,
      doctorId: o.doctorId,
      visitLogId: o.visitLogId
    });
  }

  for (const d of diagnostics) {
    events.push({
      type: 'DIAGNOSTIC',
      diagnosticType: d.type,
      at: d.capturedAt,
      meta: d.meta || {}
    });
  }

  for (const g of gaps.filter((x) => x.type === 'SIGNAL_GAP')) {
    events.push({
      type: 'GAP',
      at: g.from,
      to: g.to,
      durationMs: g.durationMs
    });
  }

  // Best-effort territory events — skip quietly if geometry unavailable
  try {
    if (user?.territoryId) {
      const TerritoryBoundary = require('../models/TerritoryBoundary');
      const boundary = await TerritoryBoundary.findOne({
        companyId: cid,
        territoryId: user.territoryId,
        isActive: true
      }).lean();
      if (boundary?.geometry && path.length >= 2) {
        // Point-in-polygon is expensive without turf; emit a single territory context marker.
        events.push({
          type: 'TERRITORY_CONTEXT',
          at: path[0].capturedAt,
          territoryId: user.territoryId,
          label: boundary.label || null
        });
      }
    }
  } catch {
    /* best-effort */
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  const checkInAt = attendance?.checkInTime ? new Date(attendance.checkInTime).getTime() : null;
  const checkOutAt = attendance?.checkOutTime
    ? new Date(attendance.checkOutTime).getTime()
    : path.length
      ? new Date(path[path.length - 1].capturedAt).getTime()
      : null;
  const workingHoursMs =
    checkInAt != null && checkOutAt != null && checkOutAt >= checkInAt
      ? checkOutAt - checkInAt
      : path.length >= 2
        ? new Date(path[path.length - 1].capturedAt) - new Date(path[0].capturedAt)
        : 0;

  const distanceMeters = Math.round(pathDistanceMeters(path));
  const visitTimeMs = stops
    .filter((s) =>
      ['Doctor Visit', 'Pharmacy Visit', 'Call Point'].includes(s.classification)
    )
    .reduce((sum, s) => sum + s.durationMs, 0);
  const idleTimeMs = stops
    .filter((s) => s.classification === 'Idle Stop' || s.classification === 'Unknown Stop')
    .reduce((sum, s) => sum + s.durationMs, 0);
  const gapMs = gaps
    .filter((g) => g.type === 'SIGNAL_GAP')
    .reduce((sum, g) => sum + g.durationMs, 0);
  const drivingTimeMs = Math.max(0, workingHoursMs - visitTimeMs - idleTimeMs - gapMs * 0.5);

  const plannedItems = plannedRoute?.items || [];
  const plannedCompleted = plannedItems.filter(
    (i) => i.status === PLAN_ITEM_STATUS.VISITED || i.status === 'VISITED' || i.status === 'COMPLETED'
  ).length;
  const plannedMissed = plannedItems.filter(
    (i) => i.status === PLAN_ITEM_STATUS.MISSED || i.status === 'MISSED'
  ).length;
  const unplannedVisits = visits.filter((v) => !v.planItemId).length;
  const doctorsVisited = new Set(
    visits.filter((v) => v.doctorId).map((v) => String(v.doctorId))
  ).size;
  const pharmaciesVisited = stops.filter((s) => s.classification === 'Pharmacy Visit').length;
  const coveragePercent =
    plannedItems.length > 0
      ? Math.round((plannedCompleted / plannedItems.length) * 100)
      : plannedRoute?.summary?.total
        ? Math.round(
            ((plannedRoute.summary.visited || 0) / plannedRoute.summary.total) * 100
          )
        : 0;

  const productiveTimeMs = visitTimeMs + Math.min(drivingTimeMs, workingHoursMs);
  const nonProductiveTimeMs = Math.max(0, workingHoursMs - productiveTimeMs);

  const summary = {
    workingHoursMs,
    distanceMeters,
    drivingTimeMs: Math.round(drivingTimeMs),
    visitTimeMs,
    idleTimeMs,
    visitCount: visits.length,
    orderCount: orders.length,
    doctorsVisited,
    pharmaciesVisited,
    plannedCompleted,
    plannedMissed,
    unplannedVisits,
    coveragePercent,
    productiveTimeMs: Math.round(productiveTimeMs),
    nonProductiveTimeMs: Math.round(nonProductiveTimeMs)
  };

  const quality = buildQuality({
    path,
    gaps,
    expectedSampleIntervalMs,
    diagnostics,
    workingHoursMs
  });

  if (options.summaryOnly) {
    return {
      date: ymd,
      userId: String(userId),
      summary,
      quality
    };
  }

  return {
    date: ymd,
    userId: String(userId),
    path,
    events,
    stops,
    gaps,
    visits,
    plannedRoute: plannedRoute
      ? {
          date: plannedRoute.date,
          checkInPoint: plannedRoute.checkInPoint,
          summary: plannedRoute.summary,
          dayExecutionState: plannedRoute.dayExecutionState,
          items: plannedRoute.items
        }
      : null,
    checkIn:
      attendance?.checkInLat != null
        ? { lat: attendance.checkInLat, lng: attendance.checkInLng, at: attendance.checkInTime }
        : attendance?.checkInTime
          ? { lat: null, lng: null, at: attendance.checkInTime }
          : null,
    checkOut:
      attendance?.checkOutLat != null
        ? {
            lat: attendance.checkOutLat,
            lng: attendance.checkOutLng,
            at: attendance.checkOutTime
          }
        : attendance?.checkOutTime
          ? { lat: null, lng: null, at: attendance.checkOutTime }
          : null,
    summary,
    quality
  };
}

function deltaNumber(a, b) {
  return (b ?? 0) - (a ?? 0);
}

async function compareRouteHistory(companyId, userId, dateA, dateB, timeZone, options = {}) {
  const [dayA, dayB] = await Promise.all([
    getRouteHistory(companyId, userId, dateA, timeZone, { ...options, summaryOnly: true }),
    getRouteHistory(companyId, userId, dateB, timeZone, { ...options, summaryOnly: true })
  ]);

  const keys = Object.keys(emptySummary());
  const deltas = {};
  for (const key of keys) {
    deltas[key] = deltaNumber(dayA.summary[key], dayB.summary[key]);
  }
  deltas.qualityScore = deltaNumber(dayA.quality?.score, dayB.quality?.score);

  return {
    userId: String(userId),
    dateA: dayA.date,
    dateB: dayB.date,
    dayA: { summary: dayA.summary, quality: dayA.quality },
    dayB: { summary: dayB.summary, quality: dayB.quality },
    deltas
  };
}

async function getRouteHistoryRange(companyId, userId, fromYmd, toYmd, timeZone, options = {}) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  let cursor = DateTime.fromISO(fromYmd, { zone: tz });
  const end = DateTime.fromISO(toYmd, { zone: tz });
  if (!cursor.isValid || !end.isValid) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(400, 'Invalid from/to date');
  }
  if (end < cursor) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(400, 'to must be on or after from');
  }

  const days = [];
  let guard = 0;
  while (cursor <= end && guard < 62) {
    const ymd = cursor.toISODate();
    // eslint-disable-next-line no-await-in-loop
    const day = await getRouteHistory(companyId, userId, ymd, timeZone, {
      ...options,
      summaryOnly: true
    });
    days.push(day);
    cursor = cursor.plus({ days: 1 });
    guard += 1;
  }

  return {
    userId: String(userId),
    from: fromYmd,
    to: toYmd,
    days
  };
}

/**
 * Historical GPS density for a date range — used for route heatmaps.
 */
async function getRouteHistoryHeatmap(companyId, userId, fromYmd, toYmd, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const fromRange = businessTime.businessDayToUtcRange(fromYmd, tz);
  const toRange = businessTime.businessDayToUtcRange(toYmd, tz);
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const uid = new mongoose.Types.ObjectId(String(userId));

  const heartbeats = await AttendanceHeartbeat.find({
    companyId: cid,
    userId: uid,
    capturedAt: { $gte: fromRange.$gte, $lte: toRange.$lte }
  })
    .select('lat lng')
    .lean();

  // Grid-bucket for density (~150m cells at mid latitudes)
  const cell = 0.0015;
  const buckets = new Map();
  for (const h of heartbeats) {
    if (typeof h.lat !== 'number' || typeof h.lng !== 'number') continue;
    const key = `${Math.round(h.lat / cell)}_${Math.round(h.lng / cell)}`;
    const prev = buckets.get(key);
    if (prev) {
      prev.weight += 1;
      prev.lat += h.lat;
      prev.lng += h.lng;
    } else {
      buckets.set(key, { lat: h.lat, lng: h.lng, weight: 1 });
    }
  }

  const points = [...buckets.values()].map((b) => ({
    lat: b.lat / b.weight,
    lng: b.lng / b.weight,
    weight: b.weight
  }));

  points.sort((a, b) => b.weight - a.weight);

  return {
    userId: String(userId),
    from: fromYmd,
    to: toYmd,
    pointCount: heartbeats.length,
    points: points.slice(0, 2000)
  };
}

module.exports = {
  getRouteHistory,
  compareRouteHistory,
  getRouteHistoryRange,
  getRouteHistoryHeatmap,
  downsamplePath,
  detectGaps,
  detectStops
};
