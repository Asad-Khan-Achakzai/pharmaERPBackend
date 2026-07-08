/**
 * Real-time advisory availability for co-visit participant selection (non-blocking).
 */
const mongoose = require('mongoose');
const PlanItem = require('../models/PlanItem');
const Attendance = require('../models/Attendance');
const Doctor = require('../models/Doctor');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const businessTime = require('../utils/businessTime');
const { haversineMeters } = require('../geo/utils/spatialQuery');
const {
  ATTENDANCE_STATUS,
  CO_VISIT_AVAILABILITY_TIER,
  PLAN_ITEM_TYPE
} = require('../constants/enums');

const TRAVEL_WARNING_METERS = 15000;
const TRAVEL_CONFLICT_METERS = 40000;

const idStr = (v) => (v == null ? '' : String(typeof v === 'object' && v._id != null ? v._id : v));

const parsePlannedMinutes = (plannedTime) => {
  if (!plannedTime) return null;
  const m = String(plannedTime).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const tierRank = (tier) => {
  if (tier === CO_VISIT_AVAILABILITY_TIER.CONFLICT) return 3;
  if (tier === CO_VISIT_AVAILABILITY_TIER.WARNING) return 2;
  return 1;
};

const maxTier = (a, b) => (tierRank(a) >= tierRank(b) ? a : b);

const doctorCoords = (doc) => {
  if (!doc || doc.latitude == null || doc.longitude == null) return null;
  const lat = Number(doc.latitude);
  const lng = Number(doc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const buildSameDayVisitSummary = (item, role, tz) => {
  const doctor = item.doctorId && typeof item.doctorId === 'object' ? item.doctorId : null;
  return {
    planItemId: String(item._id),
    doctorName: doctor?.name || null,
    plannedTime: item.plannedTime || null,
    role,
    status: item.status
  };
};

const checkAvailability = async (companyId, query, timeZone) => {
  const tz = businessTime.requireCompanyIanaZone(timeZone);
  const dateYmd = query.date;
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateYmd))) {
    throw new ApiError(400, 'date (YYYY-MM-DD) is required');
  }

  const rawIds = query.candidateUserIds;
  const candidateIds = String(rawIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => mongoose.Types.ObjectId.isValid(s));
  if (!candidateIds.length) throw new ApiError(400, 'candidateUserIds is required');
  if (candidateIds.length > 30) throw new ApiError(400, 'Too many candidates (max 30)');

  const dateDoc = businessTime.businessDayStartUtc(dateYmd, tz);
  const targetDoctorId = query.doctorId && mongoose.Types.ObjectId.isValid(query.doctorId) ? query.doctorId : null;
  const targetDoctor = targetDoctorId
    ? await Doctor.findOne({ _id: targetDoctorId, companyId, isDeleted: { $ne: true } })
        .select('name latitude longitude')
        .lean()
    : null;
  const targetCoords = doctorCoords(targetDoctor);

  const users = await User.find({ _id: { $in: candidateIds }, companyId, isActive: true })
    .select('name')
    .lean();
  const userById = Object.fromEntries(users.map((u) => [String(u._id), u]));

  const oids = candidateIds.map((id) => new mongoose.Types.ObjectId(id));
  const [ownedItems, participantItems, attendanceRows] = await Promise.all([
    PlanItem.find({
      companyId,
      employeeId: { $in: oids },
      date: dateDoc,
      isDeleted: { $ne: true }
    })
      .populate('doctorId', 'name latitude longitude')
      .lean(),
    PlanItem.find({
      companyId,
      date: dateDoc,
      isDeleted: { $ne: true },
      'participants.employeeId': { $in: oids }
    })
      .populate('doctorId', 'name latitude longitude')
      .lean(),
    Attendance.find({
      companyId,
      employeeId: { $in: oids },
      date: dateDoc,
      isDeleted: { $ne: true }
    })
      .select('employeeId status')
      .lean()
  ]);

  const attendanceByUser = Object.fromEntries(attendanceRows.map((a) => [String(a.employeeId), a.status]));
  const ownedByUser = {};
  for (const item of ownedItems) {
    const uid = idStr(item.employeeId);
    if (!ownedByUser[uid]) ownedByUser[uid] = [];
    ownedByUser[uid].push(item);
  }
  const participantByUser = {};
  for (const item of participantItems) {
    for (const p of item.participants || []) {
      const uid = idStr(p.employeeId);
      if (!candidateIds.includes(uid)) continue;
      if (!participantByUser[uid]) participantByUser[uid] = [];
      participantByUser[uid].push(item);
    }
  }

  const excludePlanItemId = query.excludePlanItemId && mongoose.Types.ObjectId.isValid(query.excludePlanItemId)
    ? String(query.excludePlanItemId)
    : null;

  return candidateIds.map((userId) => {
    const user = userById[userId];
    let tier = CO_VISIT_AVAILABILITY_TIER.AVAILABLE;
    const reasons = [];
    const sameDayVisits = [];

    const owned = (ownedByUser[userId] || []).filter((i) => String(i._id) !== excludePlanItemId);
    const asParticipant = (participantByUser[userId] || []).filter((i) => String(i._id) !== excludePlanItemId);

    for (const item of owned) {
      sameDayVisits.push(buildSameDayVisitSummary(item, 'OWNER', tz));
      if (targetDoctorId && idStr(item.doctorId) === String(targetDoctorId)) {
        tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.CONFLICT);
        reasons.push({ code: 'SAME_DOCTOR', message: 'Already has this doctor planned today', severity: 'CONFLICT' });
      }
    }
    for (const item of asParticipant) {
      sameDayVisits.push(buildSameDayVisitSummary(item, 'PARTICIPANT', tz));
      if (targetDoctorId && idStr(item.doctorId) === String(targetDoctorId)) {
        tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.CONFLICT);
        reasons.push({ code: 'COVISIT_SAME_DOCTOR', message: 'Already invited to this doctor today', severity: 'CONFLICT' });
      }
    }

    const att = attendanceByUser[userId];
    if (att === ATTENDANCE_STATUS.LEAVE || att === ATTENDANCE_STATUS.ABSENT) {
      tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.CONFLICT);
      reasons.push({
        code: att === ATTENDANCE_STATUS.LEAVE ? 'ON_LEAVE' : 'ABSENT',
        message: att === ATTENDANCE_STATUS.LEAVE ? 'On leave this day' : 'Marked absent this day',
        severity: 'CONFLICT'
      });
    } else if (att === ATTENDANCE_STATUS.HALF_DAY) {
      tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.WARNING);
      reasons.push({ code: 'HALF_DAY', message: 'Half-day attendance scheduled', severity: 'WARNING' });
    }

    if (targetCoords && owned.length) {
      let minDist = Infinity;
      for (const item of owned) {
        if (item.type !== PLAN_ITEM_TYPE.DOCTOR_VISIT) continue;
        const coords = doctorCoords(item.doctorId);
        if (!coords) continue;
        const d = haversineMeters(targetCoords.lat, targetCoords.lng, coords.lat, coords.lng);
        if (d < minDist) minDist = d;
      }
      if (Number.isFinite(minDist)) {
        if (minDist >= TRAVEL_CONFLICT_METERS) {
          tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.CONFLICT);
          reasons.push({
            code: 'TRAVEL_DISTANCE',
            message: `Nearest planned visit is ${Math.round(minDist / 1000)} km away`,
            severity: 'CONFLICT'
          });
        } else if (minDist >= TRAVEL_WARNING_METERS) {
          tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.WARNING);
          reasons.push({
            code: 'TRAVEL_DISTANCE',
            message: `Travel ~${Math.round(minDist / 1000)} km from other visits`,
            severity: 'WARNING'
          });
        }
      }
    }

    const targetMins = parsePlannedMinutes(query.plannedTime);
    if (targetMins != null && owned.length) {
      for (const item of owned) {
        const mins = parsePlannedMinutes(item.plannedTime);
        if (mins == null) continue;
        if (Math.abs(mins - targetMins) <= 30) {
          tier = maxTier(tier, CO_VISIT_AVAILABILITY_TIER.WARNING);
          reasons.push({
            code: 'TIME_OVERLAP',
            message: `Another visit around ${item.plannedTime || 'same time'}`,
            severity: 'WARNING'
          });
          break;
        }
      }
    }

    const summary =
      reasons.find((r) => r.severity === 'CONFLICT')?.message ||
      reasons.find((r) => r.severity === 'WARNING')?.message ||
      'Available';

    return {
      userId,
      name: user?.name || userId,
      availabilityTier: tier,
      summary,
      reasons,
      sameDayVisits
    };
  });
};

module.exports = { checkAvailability, CO_VISIT_AVAILABILITY_TIER };
