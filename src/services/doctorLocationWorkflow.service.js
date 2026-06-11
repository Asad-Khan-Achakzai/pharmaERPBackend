const Doctor = require('../models/Doctor');
const DoctorLocationSuggestion = require('../models/DoctorLocationSuggestion');
const ApiError = require('../utils/ApiError');
const {
  DOCTOR_LOCATION_STATUS,
  DOCTOR_LOCATION_SUGGESTION_SOURCE,
  DOCTOR_LOCATION_SUGGESTION_STATUS,
  GEO_FENCE_RESULT
} = require('../constants/enums');
const geoFenceService = require('./geoFence.service');

const MAX_SUGGESTION_ACCURACY_METERS = 150;

function extractVisitLocation(body) {
  const lat = body?.location?.lat;
  const lng = body?.location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const accuracy = body?.location?.accuracy;
  return {
    lat,
    lng,
    accuracy: typeof accuracy === 'number' && !Number.isNaN(accuracy) ? accuracy : null
  };
}

function passesSuggestionAccuracy(accuracy) {
  if (accuracy == null || Number.isNaN(accuracy)) return true;
  return accuracy <= MAX_SUGGESTION_ACCURACY_METERS;
}

async function maybeCreateSuggestionFromVisit({
  companyId,
  doctor,
  submittedByEmployeeId,
  visitLocation,
  session
}) {
  if (!visitLocation || !doctor?._id) return;

  const existing = await DoctorLocationSuggestion.findOne({
    companyId,
    doctorId: doctor._id,
    status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING
  })
    .session(session)
    .select('_id')
    .lean();
  if (existing) return;

  if (!passesSuggestionAccuracy(visitLocation.accuracy)) return;

  await DoctorLocationSuggestion.create(
    [
      {
        companyId,
        doctorId: doctor._id,
        submittedByEmployeeId,
        latitude: visitLocation.lat,
        longitude: visitLocation.lng,
        gpsAccuracy: visitLocation.accuracy,
        source: DOCTOR_LOCATION_SUGGESTION_SOURCE.VISIT_COMPLETION,
        status: DOCTOR_LOCATION_SUGGESTION_STATUS.PENDING,
        submittedAt: new Date()
      }
    ],
    { session }
  );

  if (
    !doctor.locationStatus ||
    doctor.locationStatus === DOCTOR_LOCATION_STATUS.UNVERIFIED
  ) {
    doctor.locationStatus = DOCTOR_LOCATION_STATUS.SUGGESTED;
    await doctor.save({ session });
  }
}

/**
 * Server-side doctor location workflow on successful visit completion.
 * Returns VisitLog geo audit fields; may throw 422 when STRICT geo-fence blocks.
 */
async function applyDoctorLocationOnVisitComplete({
  companyId,
  companyDoc,
  doctorId,
  body,
  submittedByEmployeeId,
  session
}) {
  const visitLocation = extractVisitLocation(body);
  const baseFields = {
    location:
      visitLocation != null ? { lat: visitLocation.lat, lng: visitLocation.lng } : undefined,
    distanceFromDoctor: null,
    geoFenceResult: GEO_FENCE_RESULT.NOT_APPLICABLE,
    gpsAccuracy: visitLocation?.accuracy ?? null
  };

  if (!doctorId) return baseFields;

  const doctor = await Doctor.findOne({
    _id: doctorId,
    companyId,
    isDeleted: { $ne: true }
  }).session(session);
  if (!doctor) return baseFields;

  if (!visitLocation) return baseFields;

  const status = doctor.locationStatus || DOCTOR_LOCATION_STATUS.UNVERIFIED;

  if (status === DOCTOR_LOCATION_STATUS.VERIFIED) {
    const fence = geoFenceService.evaluateVisitGeoFence({
      company: companyDoc,
      doctor,
      visitLat: visitLocation.lat,
      visitLng: visitLocation.lng
    });
    if (fence.applicable) {
      baseFields.distanceFromDoctor = fence.distanceMeters;
      baseFields.geoFenceResult = fence.result;
      if (fence.shouldBlock) {
        throw new ApiError(422, 'You are outside the allowed doctor visit radius.');
      }
    }
    return baseFields;
  }

  if (status === DOCTOR_LOCATION_STATUS.UNVERIFIED) {
    await maybeCreateSuggestionFromVisit({
      companyId,
      doctor,
      submittedByEmployeeId,
      visitLocation,
      session
    });
    return baseFields;
  }

  // SUGGESTED — allow visit; pending suggestion reused, no duplicate
  return baseFields;
}

module.exports = {
  applyDoctorLocationOnVisitComplete,
  extractVisitLocation,
  MAX_SUGGESTION_ACCURACY_METERS
};
