const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');
const DoctorLocationSuggestion = require('../models/DoctorLocationSuggestion');
const ApiError = require('../utils/ApiError');
const {
  DOCTOR_LOCATION_STATUS,
  DOCTOR_LOCATION_SUGGESTION_STATUS
} = require('../constants/enums');
const { parsePagination } = require('../utils/pagination');
const { userHasTenantWideAccess } = require('../utils/effectivePermissions');
const { resolveSubtreeUserIds } = require('../utils/teamScope');
const geoFenceService = require('./geoFence.service');
const auditService = require('./audit.service');

const nd = { isDeleted: { $ne: true } };

async function resolveReviewerSuggestionScope(companyId, reqUser) {
  if (userHasTenantWideAccess(reqUser)) return null;
  const subtree = await resolveSubtreeUserIds(companyId, reqUser.userId, {
    includeSelf: true,
    activeOnly: true
  });
  if (!subtree.length) return { submittedByEmployeeId: { $in: [] } };
  return { submittedByEmployeeId: { $in: subtree } };
}

const list = async (companyId, reqUser, query = {}) => {
  const { page, limit, skip, sort } = parsePagination(query);
  const status = query.status || DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING;

  const reviewerScope = await resolveReviewerSuggestionScope(companyId, reqUser);
  const filter = { companyId, status, ...(reviewerScope || {}) };

  const [docs, total] = await Promise.all([
    DoctorLocationSuggestion.find(filter)
      .sort(sort.submittedAt ? sort : { submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('doctorId', 'name specialization locationStatus latitude longitude address city')
      .populate('submittedByEmployeeId', 'name email employeeCode')
      .populate('reviewedBy', 'name email')
      .lean(),
    DoctorLocationSuggestion.countDocuments(filter)
  ]);

  return {
    docs: docs.map((row) => {
      const doctor = row.doctorId;
      let distanceFromExisting = null;
      if (
        doctor &&
        typeof doctor.latitude === 'number' &&
        typeof doctor.longitude === 'number'
      ) {
        distanceFromExisting = geoFenceService.distanceMeters(
          doctor.latitude,
          doctor.longitude,
          row.latitude,
          row.longitude
        );
        if (distanceFromExisting != null) distanceFromExisting = Math.round(distanceFromExisting);
      }
      return { ...row, distanceFromExistingVerifiedMeters: distanceFromExisting };
    }),
    total,
    page,
    limit
  };
};

const approve = async (companyId, id, reqUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const suggestion = await DoctorLocationSuggestion.findOne({
      _id: id,
      companyId,
      status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING
    }).session(session);
    if (!suggestion) throw new ApiError(404, 'Pending location suggestion not found');

    const doctor = await Doctor.findOne({ _id: suggestion.doctorId, companyId, ...nd }).session(session);
    if (!doctor) throw new ApiError(404, 'Doctor not found');

    const before = {
      locationStatus: doctor.locationStatus,
      latitude: doctor.latitude,
      longitude: doctor.longitude
    };

    doctor.latitude = suggestion.latitude;
    doctor.longitude = suggestion.longitude;
    doctor.locationStatus = DOCTOR_LOCATION_STATUS.VERIFIED;
    doctor.locationVerifiedAt = new Date();
    doctor.locationVerifiedBy = reqUser.userId;
    await doctor.save({ session });

    suggestion.status = DOCTOR_LOCATION_SUGGESTION_STATUS.APPROVED;
    suggestion.reviewedAt = new Date();
    suggestion.reviewedBy = reqUser.userId;
    suggestion.rejectionReason = null;
    await suggestion.save({ session });

    await session.commitTransaction();

    await auditService.log({
      companyId,
      userId: reqUser.userId,
      action: 'doctorLocationSuggestion.approve',
      entityType: 'DoctorLocationSuggestion',
      entityId: suggestion._id,
      changes: {
        before,
        after: {
          locationStatus: doctor.locationStatus,
          latitude: doctor.latitude,
          longitude: doctor.longitude
        }
      }
    });

    return suggestion.toObject();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

const reject = async (companyId, id, { rejectionReason }, reqUser) => {
  const suggestion = await DoctorLocationSuggestion.findOne({
    _id: id,
    companyId,
    status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING
  });
  if (!suggestion) throw new ApiError(404, 'Pending location suggestion not found');

  suggestion.status = DOCTOR_LOCATION_SUGGESTION_STATUS.REJECTED;
  suggestion.reviewedAt = new Date();
  suggestion.reviewedBy = reqUser.userId;
  suggestion.rejectionReason =
    rejectionReason != null ? String(rejectionReason).trim().slice(0, 500) : null;
  await suggestion.save();

  const doctor = await Doctor.findOne({ _id: suggestion.doctorId, companyId, ...nd });
  if (doctor && doctor.locationStatus === DOCTOR_LOCATION_STATUS.SUGGESTED) {
    const stillPending = await DoctorLocationSuggestion.exists({
      companyId,
      doctorId: doctor._id,
      status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING
    });
    if (!stillPending) {
      doctor.locationStatus = DOCTOR_LOCATION_STATUS.UNVERIFIED;
      await doctor.save();
    }
  }

  await auditService.log({
    companyId,
    userId: reqUser.userId,
    action: 'doctorLocationSuggestion.reject',
    entityType: 'DoctorLocationSuggestion',
    entityId: suggestion._id,
    changes: { rejectionReason: suggestion.rejectionReason }
  });

  return suggestion.toObject();
};

module.exports = { list, approve, reject };
