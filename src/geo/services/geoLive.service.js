const RepLocationSnapshot = require('../models/RepLocationSnapshot');
const liveTrackingService = require('../../services/liveTracking.service');
const { isGeoFeatureEnabled } = require('../utils/geoPlatformResolver');

async function upsertRepSnapshot({ companyId, userId, lat, lng, accuracy, capturedAt, locationSource = 'heartbeat' }) {
  await RepLocationSnapshot.findOneAndUpdate(
    { companyId, userId },
    { lat, lng, accuracy, capturedAt, locationSource },
    { upsert: true, new: true }
  );
}

async function listLive(companyId, reqUser, timeZone, company, query = {}) {
  if (!isGeoFeatureEnabled(company, 'managerLiveMap')) {
    const ApiError = require('../../utils/ApiError');
    const err = new ApiError(403, 'Manager live map is not enabled for this company');
    err.code = 'GEO_FEATURE_DISABLED';
    err.data = { feature: 'managerLiveMap' };
    throw err;
  }
  return liveTrackingService.listLive(companyId, reqUser, timeZone, query);
}

async function recordHeartbeat(params) {
  const { company, ...rest } = params;
  if (!isGeoFeatureEnabled(company, 'liveTracking')) {
    const ApiError = require('../../utils/ApiError');
    const err = new ApiError(403, 'Live tracking is not enabled for this company');
    err.code = 'GEO_FEATURE_DISABLED';
    err.data = { feature: 'liveTracking' };
    throw err;
  }
  const doc = await liveTrackingService.recordHeartbeat(rest);
  if (doc && typeof doc.lat === 'number' && typeof doc.lng === 'number') {
    await upsertRepSnapshot({
      companyId: rest.companyId,
      userId: rest.userId,
      lat: doc.lat,
      lng: doc.lng,
      accuracy: doc.accuracy,
      capturedAt: doc.capturedAt,
      locationSource: 'heartbeat'
    });
  }
  return doc;
}

module.exports = { listLive, recordHeartbeat, upsertRepSnapshot };
