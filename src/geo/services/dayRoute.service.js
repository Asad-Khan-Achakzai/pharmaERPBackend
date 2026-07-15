const Doctor = require('../../models/Doctor');
const CallPoint = require('../../models/CallPoint');
const PlanItem = require('../../models/PlanItem');
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

/**
 * Thin wrapper — full day Route History (enriched replay).
 * Attendance uses business-day date anchor; heartbeats use UTC day range.
 */
async function getRouteReplay(companyId, userId, dateYmd, timeZone, options = {}) {
  const routeHistoryService = require('./routeHistory.service');
  return routeHistoryService.getRouteHistory(companyId, userId, dateYmd, timeZone, options);
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
