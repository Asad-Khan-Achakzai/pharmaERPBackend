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

/**
 * (0,0) is the unconfigured placeholder some companies were saved with ("null
 * island", mid-Atlantic). Comparing real GPS against it produced ~7,800km
 * distances and a permanent OUT_OF_ZONE verdict — treat it as "not configured".
 */
const isUsableCoordinatePair = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

const companyConfiguredRadius = (company) => {
  const r = Number(company?.checkInPolicy?.radiusMeters);
  return r > 0 ? r : DEFAULT_RADIUS_METERS;
};

const normalizeCompanyDefaultPoint = (company) => {
  const p = company?.checkInPolicy;
  if (!p || !isUsableCoordinatePair(p.latitude, p.longitude)) {
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
    source: 'COMPANY_DEFAULT',
    refId: null
  };
};

const dateDocFromYmd = (ymd, tz) => businessTime.businessDayToUtcRange(ymd, tz).$gte;

/**
 * Preference order when several plans cover the same day. The rep's selected
 * CP is their declared check-in anchor for the day, so DRAFT/SUBMITTED plans
 * count too: requiring manager approval (ACTIVE) meant the CP was silently
 * ignored for most real plans and every check-in fell back to the company
 * default point — always OUT_OF_ZONE. Approval still governs the visit plan.
 */
const CP_PLAN_STATUS_RANK = {
  [WEEKLY_PLAN_STATUS.ACTIVE]: 0,
  [WEEKLY_PLAN_STATUS.SUBMITTED]: 1,
  [WEEKLY_PLAN_STATUS.DRAFT]: 2
};

const findWeeklyPlansForDay = async (companyId, employeeId, businessYmd, tz) => {
  const plans = await WeeklyPlan.find({
    companyId,
    medicalRepId: employeeId,
    status: { $in: Object.keys(CP_PLAN_STATUS_RANK) },
    isDeleted: { $ne: true }
  })
    .select('weekStartDate weekEndDate checkInConfiguration cpByDay status updatedAt')
    .lean();

  return plans.filter((plan) => {
    const ws = businessTime.businessDayKeyFromUtcInstant(plan.weekStartDate, tz);
    const we = businessTime.businessDayKeyFromUtcInstant(plan.weekEndDate, tz);
    return businessYmd >= ws && businessYmd <= we;
  });
};

const findActiveWeeklyPlanForDay = async (companyId, employeeId, businessYmd, tz) => {
  const plans = await findWeeklyPlansForDay(companyId, employeeId, businessYmd, tz);
  return plans.find((p) => p.status === WEEKLY_PLAN_STATUS.ACTIVE) || null;
};

/** Best plan for CP resolution: has a CP for that weekday, highest status rank. */
const findWeeklyPlanForDayCp = async (companyId, employeeId, businessYmd, tz) => {
  const dt = DateTime.fromISO(businessYmd);
  if (!dt.isValid) return null;
  const dayKey = CP_DAY_KEYS[dt.weekday - 1];
  const plans = await findWeeklyPlansForDay(companyId, employeeId, businessYmd, tz);
  const candidates = plans
    .filter((p) => p.cpByDay && p.cpByDay[dayKey])
    .sort(
      (a, b) =>
        (CP_PLAN_STATUS_RANK[a.status] ?? 9) - (CP_PLAN_STATUS_RANK[b.status] ?? 9) ||
        new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
    );
  return candidates[0] || null;
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
  if (!doc || !isUsableCoordinatePair(doc.latitude, doc.longitude)) {
    return null;
  }
  return {
    latitude: doc.latitude,
    longitude: doc.longitude,
    radiusMeters: fallbackRadius,
    locationName: String(doc.name || 'Doctor').trim() || 'Doctor',
    refId: doc._id
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
  if (!cp || !isUsableCoordinatePair(cp.latitude, cp.longitude)) {
    return null;
  }
  return {
    latitude: cp.latitude,
    longitude: cp.longitude,
    radiusMeters: fallbackRadius,
    locationName: String(cp.name || 'CP').trim() || 'CP',
    policyType: CHECKIN_POLICY_TYPE.CUSTOM_LOCATION,
    source: 'WEEKLY_PLAN_CP',
    refId: cp._id
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
  /** Configured radius applies even when the default point's coords are unusable. */
  const fallbackRadius = companyConfiguredRadius(company);

  /**
   * Highest priority: the CP selected for today's weekday in the weekly plan
   * (any non-terminal plan status — see CP_PLAN_STATUS_RANK). Only the
   * coordinate source changes; radius + distance evaluation stay the same.
   */
  const cpPlan = await findWeeklyPlanForDayCp(company._id, employeeId, businessYmd, tz);
  if (cpPlan) {
    const dayCp = await resolveDayCallPoint(company._id, cpPlan, businessYmd, fallbackRadius);
    if (dayCp) return dayCp;
  }

  /** checkInConfiguration fallback keeps its original ACTIVE-only semantics. */
  const weeklyPlan = await findActiveWeeklyPlanForDay(company._id, employeeId, businessYmd, tz);
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
    if (loc && isUsableCoordinatePair(loc.latitude, loc.longitude)) {
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
    radiusMeters: s.radiusMeters,
    source: s.source ?? null,
    refId: s.refId ?? null
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
        radiusMeters: point.radiusMeters,
        source: point.source || null,
        refId: point.refId || null
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
  findActiveWeeklyPlanForDay,
  findWeeklyPlanForDayCp,
  resolveDayCallPoint,
  ATTENDANCE_SYSTEM_MODE
};
