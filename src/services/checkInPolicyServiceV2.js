const mongoose = require('mongoose');
const { DateTime } = require('luxon');
const Attendance = require('../models/Attendance');
const Company = require('../models/Company');
const WeeklyPlan = require('../models/WeeklyPlan');
const PlanItem = require('../models/PlanItem');
const Doctor = require('../models/Doctor');
const CallPoint = require('../models/CallPoint');
const {
  ATTENDANCE_SYSTEM_MODE,
  ATTENDANCE_LOCATION_STATUS,
  CHECKIN_POLICY_TYPE,
  CP_DAY_KEYS,
  WEEKLY_PLAN_STATUS,
  PLAN_ITEM_TYPE
} = require('../constants/enums');
const businessTime = require('../utils/businessTime');
const { distanceMeters } = require('./geoFence.service');

const DEFAULT_RADIUS_METERS = 150;

const companySelectFields =
  'attendanceSystemMode checkInPolicy timeZone name attendanceConfigVersion updatedAt';

const isV2Mode = (company) =>
  company && company.attendanceSystemMode === ATTENDANCE_SYSTEM_MODE.CHECKIN_POLICY_V2;

const getCompanyForCheckInPolicy = async (companyId) =>
  Company.findById(companyId).select(companySelectFields).lean();

const normalizeCompanyDefaultPoint = (company) => {
  const p = company?.checkInPolicy;
  if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number') {
    return null;
  }
  const radius =
    Number(p.radiusMeters) > 0 ? Number(p.radiusMeters) : DEFAULT_RADIUS_METERS;
  const name = String(p.locationName || company?.name || 'Company default').trim();
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    radiusMeters: radius,
    locationName: name || 'Company default',
    policyType: CHECKIN_POLICY_TYPE.COMPANY_DEFAULT,
    source: 'COMPANY_DEFAULT'
  };
};

const dateDocFromYmd = (ymd, tz) => businessTime.businessDayToUtcRange(ymd, tz).$gte;

const findActiveWeeklyPlanForDay = async (companyId, employeeId, businessYmd, tz) => {
  const plans = await WeeklyPlan.find({
    companyId,
    medicalRepId: employeeId,
    status: WEEKLY_PLAN_STATUS.ACTIVE,
    isDeleted: { $ne: true }
  })
    .select('weekStartDate weekEndDate checkInConfiguration cpByDay')
    .lean();

  for (const plan of plans) {
    const ws = businessTime.businessDayKeyFromUtcInstant(plan.weekStartDate, tz);
    const we = businessTime.businessDayKeyFromUtcInstant(plan.weekEndDate, tz);
    if (businessYmd >= ws && businessYmd <= we) return plan;
  }
  return null;
};

const resolveDoctorPoint = async (companyId, doctorId, fallbackRadius) => {
  if (!doctorId) return null;
  const doc = await Doctor.findOne({
    _id: doctorId,
    companyId,
    isDeleted: { $ne: true }
  })
    .select('name latitude longitude')
    .lean();
  if (!doc || typeof doc.latitude !== 'number' || typeof doc.longitude !== 'number') {
    return null;
  }
  return {
    latitude: doc.latitude,
    longitude: doc.longitude,
    radiusMeters: fallbackRadius,
    locationName: String(doc.name || 'Doctor').trim() || 'Doctor'
  };
};

const resolveFirstPlannedVisitPoint = async (
  companyId,
  employeeId,
  weeklyPlanId,
  businessYmd,
  tz,
  fallbackRadius
) => {
  const dateDoc = dateDocFromYmd(businessYmd, tz);
  const item = await PlanItem.findOne({
    companyId,
    employeeId,
    weeklyPlanId,
    date: dateDoc,
    type: PLAN_ITEM_TYPE.DOCTOR_VISIT,
    isDeleted: { $ne: true }
  })
    .sort({ sequenceOrder: 1, createdAt: 1 })
    .select('doctorId')
    .lean();

  if (!item?.doctorId) return null;
  return resolveDoctorPoint(companyId, item.doctorId, fallbackRadius);
};

/**
 * Resolve the CP (call point) selected for the given business day on a weekly plan.
 * Reads cpByDay[<weekday>] and loads the active CallPoint's coordinates. Radius is
 * inherited from the company default (distance/radius logic is otherwise unchanged).
 */
const resolveDayCallPoint = async (companyId, weeklyPlan, businessYmd, fallbackRadius) => {
  if (!weeklyPlan?.cpByDay) return null;
  const dt = DateTime.fromISO(businessYmd);
  if (!dt.isValid) return null;
  const dayKey = CP_DAY_KEYS[dt.weekday - 1];
  const cpId = weeklyPlan.cpByDay[dayKey];
  if (!cpId) return null;

  const cp = await CallPoint.findOne({
    _id: cpId,
    companyId,
    isActive: true,
    isDeleted: { $ne: true }
  })
    .select('name latitude longitude')
    .lean();
  if (!cp || typeof cp.latitude !== 'number' || typeof cp.longitude !== 'number') {
    return null;
  }
  return {
    latitude: cp.latitude,
    longitude: cp.longitude,
    radiusMeters: fallbackRadius,
    locationName: String(cp.name || 'CP').trim() || 'CP',
    policyType: CHECKIN_POLICY_TYPE.CUSTOM_LOCATION,
    source: 'WEEKLY_PLAN_CP'
  };
};

const resolveActiveCheckInPoint = async ({
  company,
  employeeId,
  businessYmd,
  timeZone
}) => {
  if (!isV2Mode(company)) return null;

  const tz = businessTime.requireCompanyIanaZone(timeZone || company.timeZone);
  const companyDefault = normalizeCompanyDefaultPoint(company);
  const fallbackRadius = companyDefault?.radiusMeters ?? DEFAULT_RADIUS_METERS;

  const weeklyPlan = await findActiveWeeklyPlanForDay(company._id, employeeId, businessYmd, tz);

  /**
   * Highest priority: the CP selected for today's weekday in the weekly plan.
   * Only the coordinate source changes; radius + distance evaluation stay the same.
   */
  const dayCp = await resolveDayCallPoint(company._id, weeklyPlan, businessYmd, fallbackRadius);
  if (dayCp) return dayCp;

  const config = weeklyPlan?.checkInConfiguration;

  if (!config || !config.policyType) {
    return companyDefault;
  }

  const policyType = config.policyType;

  if (policyType === CHECKIN_POLICY_TYPE.COMPANY_DEFAULT) {
    return companyDefault ? { ...companyDefault, source: 'WEEKLY_PLAN' } : null;
  }

  if (policyType === CHECKIN_POLICY_TYPE.CUSTOM_LOCATION) {
    const loc = config.customLocation;
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      const radius =
        Number(loc.radiusMeters) > 0 ? Number(loc.radiusMeters) : fallbackRadius;
      return {
        latitude: loc.latitude,
        longitude: loc.longitude,
        radiusMeters: radius,
        locationName: String(loc.locationName || 'Custom location').trim() || 'Custom location',
        policyType: CHECKIN_POLICY_TYPE.CUSTOM_LOCATION,
        source: 'WEEKLY_PLAN'
      };
    }
    return companyDefault;
  }

  if (policyType === CHECKIN_POLICY_TYPE.SPECIFIC_DOCTOR) {
    const pt = await resolveDoctorPoint(company._id, config.doctorId, fallbackRadius);
    if (pt) {
      return { ...pt, policyType: CHECKIN_POLICY_TYPE.SPECIFIC_DOCTOR, source: 'WEEKLY_PLAN' };
    }
    return companyDefault;
  }

  if (policyType === CHECKIN_POLICY_TYPE.FIRST_PLANNED_VISIT) {
    if (weeklyPlan) {
      const pt = await resolveFirstPlannedVisitPoint(
        company._id,
        employeeId,
        weeklyPlan._id,
        businessYmd,
        tz,
        fallbackRadius
      );
      if (pt) {
        return {
          ...pt,
          policyType: CHECKIN_POLICY_TYPE.FIRST_PLANNED_VISIT,
          source: 'WEEKLY_PLAN'
        };
      }
    }
    return companyDefault;
  }

  return companyDefault;
};

const evaluateGpsAgainstPoint = (point, lat, lng) => {
  if (!point) {
    return { attendanceLocationStatus: undefined, distanceFromCheckInPoint: null };
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { attendanceLocationStatus: undefined, distanceFromCheckInPoint: null };
  }
  const dist = distanceMeters(point.latitude, point.longitude, lat, lng);
  if (dist == null) {
    return { attendanceLocationStatus: undefined, distanceFromCheckInPoint: null };
  }
  const rounded = Math.round(dist);
  const within = rounded <= point.radiusMeters;
  return {
    attendanceLocationStatus: within
      ? ATTENDANCE_LOCATION_STATUS.WITHIN_ZONE
      : ATTENDANCE_LOCATION_STATUS.OUT_OF_ZONE,
    distanceFromCheckInPoint: rounded
  };
};

/** Read legacy DB fields into canonical V2 shape (no writes). */
const readRequiredCheckInLocation = (att) => {
  if (!att) return undefined;
  const loc = att.requiredCheckInLocation;
  if (loc && typeof loc === 'object' && loc.name) {
    return {
      name: loc.name,
      latitude: typeof loc.latitude === 'number' ? loc.latitude : undefined,
      longitude: typeof loc.longitude === 'number' ? loc.longitude : undefined
    };
  }
  const snap = att.resolvedCheckInPolicy;
  if (snap && snap.locationName) {
    return {
      name: snap.locationName,
      latitude: typeof snap.latitude === 'number' ? snap.latitude : undefined,
      longitude: typeof snap.longitude === 'number' ? snap.longitude : undefined
    };
  }
  if (att.requiredCheckInLocationName) {
    return { name: att.requiredCheckInLocationName };
  }
  return undefined;
};

const readResolvedCheckInPolicy = (att) => {
  if (!att?.resolvedCheckInPolicy) return undefined;
  const s = att.resolvedCheckInPolicy;
  if (!s.type && !s.locationName) return undefined;
  return {
    type: s.type,
    locationName: s.locationName,
    latitude: s.latitude,
    longitude: s.longitude,
    radiusMeters: s.radiusMeters
  };
};

/** Standard API projection for V2 attendance fields. */
const buildResponseFields = (att) => {
  if (!att) return {};
  const plain = att.toObject ? att.toObject() : att;
  const status = plain.attendanceLocationStatus;
  const distance = plain.distanceFromCheckInPoint;
  const requiredCheckInLocation = readRequiredCheckInLocation(plain);
  const resolvedCheckInPolicy = readResolvedCheckInPolicy(plain);

  if (!status && distance == null && !requiredCheckInLocation && !resolvedCheckInPolicy) {
    return {};
  }

  const out = {};
  if (status) out.attendanceLocationStatus = status;
  if (distance != null) out.distanceFromCheckInPoint = distance;
  if (requiredCheckInLocation) out.requiredCheckInLocation = requiredCheckInLocation;
  if (resolvedCheckInPolicy) out.resolvedCheckInPolicy = resolvedCheckInPolicy;
  return out;
};

/**
 * Internal: compute V2 metadata from resolved point + GPS (no DB writes).
 */
async function computeV2Metadata(context) {
  const { companyId, employeeId, businessYmd, timeZone, body, attendanceRow } = context;
  const company = await getCompanyForCheckInPolicy(companyId);
  if (!isV2Mode(company)) return null;

  const tz = businessTime.requireCompanyIanaZone(timeZone || company.timeZone);
  const ymd =
    businessYmd ||
    (attendanceRow?.date
      ? businessTime.businessDayKeyFromUtcInstant(attendanceRow.date, tz)
      : businessTime.nowInBusinessTime(tz).toISODate());

  const point = await resolveActiveCheckInPoint({
    company,
    employeeId,
    businessYmd: ymd,
    timeZone: tz
  });

  const lat =
    body?.lat != null
      ? Number(body.lat)
      : attendanceRow?.checkInLat != null
        ? Number(attendanceRow.checkInLat)
        : undefined;
  const lng =
    body?.lng != null
      ? Number(body.lng)
      : attendanceRow?.checkInLng != null
        ? Number(attendanceRow.checkInLng)
        : undefined;

  const evalResult = evaluateGpsAgainstPoint(point, lat, lng);

  const requiredCheckInLocation = point
    ? {
        name: point.locationName,
        latitude: point.latitude,
        longitude: point.longitude
      }
    : undefined;

  const resolvedCheckInPolicy = point
    ? {
        type: point.policyType,
        locationName: point.locationName,
        latitude: point.latitude,
        longitude: point.longitude,
        radiusMeters: point.radiusMeters
      }
    : undefined;

  return {
    attendanceLocationStatus: evalResult.attendanceLocationStatus,
    distanceFromCheckInPoint: evalResult.distanceFromCheckInPoint,
    requiredCheckInLocation,
    resolvedCheckInPolicy
  };
}

/**
 * FIX 1: Atomic post-save V2 enrichment by attendance id.
 * LEGACY companies: no-op. Never creates duplicate rows. Never throws to caller.
 */
const applyCheckInPolicyV2 = async (attendanceId, context) => {
  if (!attendanceId || !context?.companyId) return null;

  try {
    const company = await getCompanyForCheckInPolicy(context.companyId);
    if (!isV2Mode(company)) return null;

    const att = await Attendance.findOne({
      _id: attendanceId,
      companyId: context.companyId,
      isDeleted: { $ne: true }
    }).lean();

    if (!att || !att.checkInTime) return null;

    const meta = await computeV2Metadata({ ...context, attendanceRow: att });
    if (!meta) return null;

    const $set = {
      attendanceLocationStatus: meta.attendanceLocationStatus,
      distanceFromCheckInPoint: meta.distanceFromCheckInPoint
    };
    if (meta.requiredCheckInLocation) {
      $set.requiredCheckInLocation = meta.requiredCheckInLocation;
    }

    // FIX 3: immutable policy snapshot — set only once per attendance row
    if (meta.resolvedCheckInPolicy && !att.resolvedCheckInPolicy) {
      $set.resolvedCheckInPolicy = meta.resolvedCheckInPolicy;
    }

    const updated = await Attendance.findOneAndUpdate(
      {
        _id: attendanceId,
        companyId: context.companyId,
        isDeleted: { $ne: true }
      },
      { $set },
      { new: true }
    );

    return updated;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[checkInPolicyV2] applyCheckInPolicyV2 failed', {
      attendanceId: String(attendanceId),
      msg
    });
    return null;
  }
};

/** @deprecated Use applyCheckInPolicyV2(attendanceId, context). Kept for internal compat. */
const applyToAttendanceRecord = async (att, context) => {
  if (!att?._id) return att;
  const updated = await applyCheckInPolicyV2(att._id, context);
  return updated || att;
};

const previewForEmployeeToday = async (companyId, employeeId, timeZone) => {
  const company = await getCompanyForCheckInPolicy(companyId);
  if (!isV2Mode(company)) {
    return { enabled: false };
  }
  const tz = businessTime.requireCompanyIanaZone(timeZone || company.timeZone);
  const businessYmd = businessTime.nowInBusinessTime(tz).toISODate();
  const point = await resolveActiveCheckInPoint({
    company,
    employeeId,
    businessYmd,
    timeZone: tz
  });
  if (!point) {
    return {
      enabled: true,
      requiredCheckInLocation: null,
      policyType: null,
      source: null
    };
  }
  return {
    enabled: true,
    policyType: point.policyType,
    source: point.source,
    requiredCheckInLocation: {
      name: point.locationName,
      latitude: point.latitude,
      longitude: point.longitude,
      radiusMeters: point.radiusMeters
    }
  };
};

const bumpAttendanceConfigVersion = async (companyId) => {
  if (!companyId) return;
  await Company.updateOne({ _id: companyId }, { $inc: { attendanceConfigVersion: 1 } });
};

module.exports = {
  isV2Mode,
  getCompanyForCheckInPolicy,
  resolveActiveCheckInPoint,
  evaluateGpsAgainstPoint,
  applyCheckInPolicyV2,
  applyToAttendanceRecord,
  buildResponseFields,
  readRequiredCheckInLocation,
  readResolvedCheckInPolicy,
  previewForEmployeeToday,
  bumpAttendanceConfigVersion,
  ATTENDANCE_SYSTEM_MODE
};
