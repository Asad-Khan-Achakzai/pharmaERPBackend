const mongoose = require('mongoose');
const Doctor = require('../../models/Doctor');
const CallPoint = require('../../models/CallPoint');
const PlanItem = require('../../models/PlanItem');
const AttendanceHeartbeat = require('../../models/AttendanceHeartbeat');
const Attendance = require('../../models/Attendance');
const VisitLog = require('../../models/VisitLog');
const planItemService = require('../../services/planItem.service');
const checkInPolicyServiceV2 = require('../../services/checkInPolicyServiceV2');
const businessTime = require('../../utils/businessTime');
const ApiError = require('../../utils/ApiError');

const nd = { isDeleted: { $ne: true } };

const DOCTOR_MAP_SELECT =
  'name specialization latitude longitude locationStatus locationName city territoryId isActive';

async function getDayRoute(companyId, employeeId, dateYmd, timeZone) {
  const execution = await planItemService.buildTodayExecution(companyId, employeeId, dateYmd, timeZone);
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = execution.date || businessTime.nowInBusinessTime(tz).toISODate();

  let checkInPoint = null;
  const weeklyPlan = await checkInPolicyServiceV2.findActiveWeeklyPlanForDay(
    companyId,
    employeeId,
    ymd,
    tz
  );
  if (weeklyPlan) {
    const cp = await checkInPolicyServiceV2.resolveDayCallPoint(companyId, weeklyPlan, ymd, 150);
    if (cp) {
      checkInPoint = {
        id: null,
        name: cp.locationName,
        lat: cp.latitude,
        lng: cp.longitude
      };
    }
    const custom = weeklyPlan.checkInConfiguration?.customLocation;
    if (!checkInPoint && custom?.latitude != null && custom?.longitude != null) {
      checkInPoint = {
        id: null,
        name: custom.locationName || 'Custom check-in',
        lat: custom.latitude,
        lng: custom.longitude
      };
    }
  }

  const items = (execution.items || []).map((item, idx) => {
    const doctor = item.doctorId && typeof item.doctorId === 'object' ? item.doctorId : null;
    const visitLog = item.visitLogId && typeof item.visitLogId === 'object' ? item.visitLogId : null;
    return {
      planItemId: item._id,
      sequenceOrder: item.sequenceOrder ?? idx + 1,
      status: item.status,
      doctor: doctor
        ? {
            id: doctor._id,
            name: doctor.name,
            specialization: doctor.specialization,
            lat: doctor.latitude,
            lng: doctor.longitude,
            locationStatus: doctor.locationStatus
          }
        : null,
      visitLocation:
        visitLog?.location?.lat != null
          ? {
              lat: visitLog.location.lat,
              lng: visitLog.location.lng,
              geoFenceResult: visitLog.geoFenceResult,
              distanceFromDoctor: visitLog.distanceFromDoctor
            }
          : null
    };
  });

  return {
    date: ymd,
    checkInPoint,
    summary: execution.summary,
    dayExecutionState: execution.dayExecutionState,
    items
  };
}

async function listDoctorsForMap(companyId, query = {}) {
  const filter = { companyId, isActive: true, ...nd };
  if (query.territoryId) filter.territoryId = query.territoryId;
  if (query.locationStatus) filter.locationStatus = query.locationStatus;

  const limit = Math.min(Number(query.limit) || 500, 2000);
  const doctors = await Doctor.find(filter).select(DOCTOR_MAP_SELECT).limit(limit).lean();
  return doctors
    .filter((d) => typeof d.latitude === 'number' && typeof d.longitude === 'number')
    .map((d) => ({
      id: d._id,
      name: d.name,
      specialization: d.specialization,
      lat: d.latitude,
      lng: d.longitude,
      locationStatus: d.locationStatus,
      territoryId: d.territoryId
    }));
}

async function listCallPointsForMap(companyId) {
  const rows = await CallPoint.find({ companyId, isActive: true, ...nd })
    .select('name latitude longitude isActive')
    .lean();
  return rows.map((cp) => ({
    id: cp._id,
    name: cp.name,
    lat: cp.latitude,
    lng: cp.longitude
  }));
}

async function getRouteReplay(companyId, userId, dateYmd, timeZone) {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const ymd = dateYmd || businessTime.nowInBusinessTime(tz).toISODate();
  const range = businessTime.businessDayToUtcRange(ymd, tz);
  const start = range.$gte;
  const end = range.$lte;
  const cid = new mongoose.Types.ObjectId(String(companyId));
  const uid = new mongoose.Types.ObjectId(String(userId));

  const [heartbeats, attendance, visits] = await Promise.all([
    AttendanceHeartbeat.find({
      companyId: cid,
      userId: uid,
      capturedAt: { $gte: start, $lte: end }
    })
      .sort({ capturedAt: 1 })
      .select('lat lng accuracy capturedAt')
      .lean(),
    Attendance.findOne({ companyId: cid, employeeId: uid, date: start, ...nd })
      .select('checkInLat checkInLng checkInTime checkOutLat checkOutLng checkOutTime')
      .lean(),
    VisitLog.find({
      companyId: cid,
      employeeId: uid,
      createdAt: { $gte: start, $lte: end },
      ...nd
    })
      .sort({ createdAt: 1 })
      .select('location createdAt doctorId distanceFromDoctor geoFenceResult')
      .lean()
  ]);

  const path = heartbeats.map((h) => ({
    lat: h.lat,
    lng: h.lng,
    accuracy: h.accuracy,
    capturedAt: h.capturedAt,
    type: 'heartbeat'
  }));

  return {
    date: ymd,
    path,
    checkIn:
      attendance?.checkInLat != null
        ? { lat: attendance.checkInLat, lng: attendance.checkInLng, at: attendance.checkInTime }
        : null,
    checkOut:
      attendance?.checkOutLat != null
        ? { lat: attendance.checkOutLat, lng: attendance.checkOutLng, at: attendance.checkOutTime }
        : null,
    visits: visits.map((v) => ({
      lat: v.location?.lat,
      lng: v.location?.lng,
      at: v.createdAt,
      doctorId: v.doctorId,
      geoFenceResult: v.geoFenceResult,
      distanceFromDoctor: v.distanceFromDoctor
    }))
  };
}

async function getVisitContext(companyId, planItemId) {
  const item = await PlanItem.findOne({ _id: planItemId, companyId, ...nd })
    .populate('doctorId', DOCTOR_MAP_SELECT)
    .lean();
  if (!item) throw new ApiError(404, 'Plan item not found');
  const doctor = item.doctorId;
  return {
    planItemId: item._id,
    status: item.status,
    doctor:
      doctor && typeof doctor === 'object'
        ? {
            id: doctor._id,
            name: doctor.name,
            lat: doctor.latitude,
            lng: doctor.longitude,
            locationStatus: doctor.locationStatus
          }
        : null
  };
}

module.exports = {
  getDayRoute,
  listDoctorsForMap,
  listCallPointsForMap,
  getRouteReplay,
  getVisitContext
};
