const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const PlanItem = require('../../models/PlanItem');
const WeeklyPlan = require('../../models/WeeklyPlan');
const VisitLog = require('../../models/VisitLog');
const Attendance = require('../../models/Attendance');
const TerritoryBoundary = require('../models/TerritoryBoundary');
const weeklyPlanService = require('../../services/weeklyPlan.service');
const checkInPolicyServiceV2 = require('../../services/checkInPolicyServiceV2');
const businessTime = require('../../utils/businessTime');
const ApiError = require('../../utils/ApiError');

const nd = { isDeleted: { $ne: true } };

async function getWeeklyRoute(companyId, weeklyPlanId, dateYmd, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = dateYmd || businessTime.nowInBusinessTime(tz).toISODate();
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);

  const plan = await WeeklyPlan.findOne({ _id: weeklyPlanId, companyId, ...nd }).lean();
  if (!plan) throw new ApiError(404, 'Weekly plan not found');

  const items = await PlanItem.find({
    companyId,
    weeklyPlanId,
    date: dateDoc,
    ...nd
  })
    .populate('doctorId', 'name specialization latitude longitude locationStatus')
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .lean();

  const cp = await checkInPolicyServiceV2.resolveDayCallPoint(companyId, plan, ymd, 150);

  return {
    weeklyPlanId,
    date: ymd,
    checkInPoint: cp
      ? { name: cp.locationName, lat: cp.latitude, lng: cp.longitude }
      : null,
    items: items.map((item, idx) => {
      const doctor = item.doctorId && typeof item.doctorId === 'object' ? item.doctorId : null;
      return {
        planItemId: item._id,
        sequenceOrder: item.sequenceOrder ?? idx + 1,
        status: item.status,
        doctor: doctor
          ? {
              id: doctor._id,
              name: doctor.name,
              lat: doctor.latitude,
              lng: doctor.longitude,
              locationStatus: doctor.locationStatus
            }
          : null
      };
    })
  };
}

async function getAttendanceZones(companyId, query, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = query.date || businessTime.nowInBusinessTime(tz).toISODate();
  const dateDoc = businessTime.businessDayStartUtc(ymd, tz);
  const filter = { companyId, date: dateDoc, ...nd };
  if (query.attendanceLocationStatus) {
    filter.attendanceLocationStatus = query.attendanceLocationStatus;
  }

  const rows = await Attendance.find(filter)
    .select(
      'employeeId checkInLat checkInLng checkInAccuracy attendanceLocationStatus distanceFromCheckInPoint requiredCheckInLocation checkInTime'
    )
    .populate('employeeId', 'name')
    .lean();

  return rows.map((row) => ({
    employeeId: row.employeeId?._id || row.employeeId,
    name: row.employeeId?.name || 'Employee',
    checkIn: {
      lat: row.checkInLat,
      lng: row.checkInLng,
      accuracy: row.checkInAccuracy,
      at: row.checkInTime
    },
    expected: row.requiredCheckInLocation
      ? {
          name: row.requiredCheckInLocation.name,
          lat: row.requiredCheckInLocation.latitude,
          lng: row.requiredCheckInLocation.longitude,
          radiusMeters: row.requiredCheckInLocation.radiusMeters
        }
      : null,
    attendanceLocationStatus: row.attendanceLocationStatus,
    distanceFromCheckInPoint: row.distanceFromCheckInPoint
  }));
}

async function getHeatMap(companyId, query, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const fromYmd = query.from || businessTime.nowInBusinessTime(tz).startOf('month').toISODate();
  const toYmd = query.to || businessTime.nowInBusinessTime(tz).toISODate();
  const from = businessTime.businessDayStartUtc(fromYmd, tz);
  const to = businessTime.businessDayToUtcRange(toYmd, tz).$lte;

  const match = {
    companyId: new mongoose.Types.ObjectId(String(companyId)),
    createdAt: { $gte: from, $lte: to },
    'location.lat': { $type: 'number' },
    'location.lng': { $type: 'number' },
    ...nd
  };

  const points = await VisitLog.find(match).select('location.lat location.lng doctorId').lean();

  return {
    from: fromYmd,
    to: toYmd,
    metric: query.metric || 'visits',
    points: points.map((p) => ({ lat: p.location.lat, lng: p.location.lng, weight: 1 }))
  };
}

async function optimizeRoute(companyId, payload, reqUser, timeZone) {
  return weeklyPlanService.optimizeRoute(companyId, payload.weeklyPlanId, payload, reqUser, timeZone, {});
}

async function listTerritoryBoundaries(companyId, query = {}) {
  const filter = { companyId, isActive: true, ...nd };
  if (query.territoryId) filter.territoryId = query.territoryId;
  return TerritoryBoundary.find(filter).lean();
}

async function upsertTerritoryBoundary(companyId, payload) {
  const { territoryId, geometry, label } = payload;
  if (!territoryId || !geometry?.type || !geometry?.coordinates) {
    throw new ApiError(400, 'territoryId and geometry are required');
  }
  return TerritoryBoundary.findOneAndUpdate(
    { companyId, territoryId },
    { companyId, territoryId, geometry, label: label || '', isActive: true },
    { upsert: true, new: true }
  ).lean();
}

async function getRouteAnalytics(companyId, query, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const fromYmd = query.from || businessTime.nowInBusinessTime(tz).startOf('month').toISODate();
  const toYmd = query.to || businessTime.nowInBusinessTime(tz).toISODate();
  const from = businessTime.businessDayStartUtc(fromYmd, tz);
  const to = businessTime.businessDayToUtcRange(toYmd, tz).$lte;

  const cid = new mongoose.Types.ObjectId(String(companyId));
  const match = { companyId: cid, createdAt: { $gte: from, $lte: to }, ...nd };

  const [visitCount, outOfFence, avgDistance] = await Promise.all([
    VisitLog.countDocuments(match),
    VisitLog.countDocuments({ ...match, geoFenceResult: 'OUTSIDE_RADIUS' }),
    VisitLog.aggregate([
      { $match: { ...match, distanceFromDoctor: { $type: 'number' } } },
      { $group: { _id: null, avg: { $avg: '$distanceFromDoctor' } } }
    ])
  ]);

  return {
    from: fromYmd,
    to: toYmd,
    visitsRecorded: visitCount,
    visitsOutsideGeoFence: outOfFence,
    averageDistanceFromDoctorMeters: avgDistance[0]?.avg ? Math.round(avgDistance[0].avg) : null
  };
}

async function getTravelAnalytics(companyId, query, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = query.date || businessTime.nowInBusinessTime(tz).toISODate();
  const routeHistoryService = require('./routeHistory.service');
  const userId = query.userId;
  if (!userId) throw new ApiError(400, 'userId is required');

  const day = await routeHistoryService.getRouteHistory(companyId, userId, ymd, timeZone, {
    summaryOnly: false,
    downsample: true,
    maxPoints: 2000
  });

  return {
    date: ymd,
    userId,
    heartbeatPings: day.path?.length || 0,
    estimatedDistanceMeters: Math.round(day.summary?.distanceMeters || 0),
    visitsCompleted: day.summary?.visitCount || day.visits?.length || 0,
    drivingTimeMs: day.summary?.drivingTimeMs || 0,
    visitTimeMs: day.summary?.visitTimeMs || 0,
    idleTimeMs: day.summary?.idleTimeMs || 0,
    productiveTimeMs: day.summary?.productiveTimeMs || 0,
    coveragePercent: day.summary?.coveragePercent || 0,
    quality: day.quality || null
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

module.exports = {
  getWeeklyRoute,
  getAttendanceZones,
  getHeatMap,
  optimizeRoute,
  listTerritoryBoundaries,
  upsertTerritoryBoundary,
  getRouteAnalytics,
  getTravelAnalytics
};
