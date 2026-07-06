const RepLocationSnapshot = require('../models/RepLocationSnapshot');
const liveTrackingService = require('../../services/liveTracking.service');
const { isGeoFeatureEnabled, resolveGeoPlatform } = require('../utils/geoPlatformResolver');
const { shouldUpdateSnapshot } = require('../utils/snapshotQualityGate');
const realtimeHub = require('../../realtime/RealtimeHub');

async function upsertRepSnapshot(params) {
  const { companyId, userId, company, ...incoming } = params;
  const geo = resolveGeoPlatform(company);
  const qualityGateEnabled = geo.liveTracking?.snapshotQualityGateEnabled !== false;

  const existing = await RepLocationSnapshot.findOne({ companyId, userId }).lean();
  if (qualityGateEnabled && !shouldUpdateSnapshot(incoming, existing)) {
    return existing;
  }

  const doc = await RepLocationSnapshot.findOneAndUpdate(
    { companyId, userId },
    {
      lat: incoming.lat,
      lng: incoming.lng,
      accuracy: incoming.accuracy,
      confidence: incoming.confidence,
      speed: incoming.speed,
      heading: incoming.heading,
      trackingContext: incoming.trackingContext,
      expectedNextPingMs: incoming.expectedNextPingMs,
      capturedAt: incoming.capturedAt,
      uploadedAt: new Date(),
      locationSource: incoming.locationSource || 'heartbeat'
    },
    { upsert: true, new: true }
  );

  realtimeHub.publish(String(companyId), 'live-map', {
    type: 'rep.location.updated',
    payload: {
      userId: String(userId),
      lat: doc.lat,
      lng: doc.lng,
      accuracy: doc.accuracy,
      confidence: doc.confidence,
      speed: doc.speed,
      heading: doc.heading,
      trackingContext: doc.trackingContext,
      capturedAt: doc.capturedAt,
      expectedNextPingMs: doc.expectedNextPingMs
    }
  });

  return doc;
}

async function listLive(companyId, reqUser, timeZone, company, query = {}) {
  if (!isGeoFeatureEnabled(company, 'managerLiveMap')) {
    const ApiError = require('../../utils/ApiError');
    const err = new ApiError(403, 'Manager live map is not enabled for this company');
    err.code = 'GEO_FEATURE_DISABLED';
    err.data = { feature: 'managerLiveMap' };
    throw err;
  }
  return liveTrackingService.listLive(companyId, reqUser, timeZone, company, query);
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
  const doc = await liveTrackingService.recordHeartbeat({ ...rest, company });
  if (doc && typeof doc.lat === 'number' && typeof doc.lng === 'number') {
    await upsertRepSnapshot({
      companyId: rest.companyId,
      userId: rest.userId,
      company,
      lat: doc.lat,
      lng: doc.lng,
      accuracy: doc.accuracy,
      confidence: doc.confidence,
      speed: doc.speed,
      heading: doc.heading,
      trackingContext: doc.trackingContext,
      expectedNextPingMs: doc.expectedNextPingMs,
      capturedAt: doc.capturedAt,
      locationSource: 'heartbeat'
    });
  }
  return doc;
}

async function recordHeartbeatsBatch(params) {
  const { company, heartbeats, ...rest } = params;
  const results = [];
  for (const beat of heartbeats) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await recordHeartbeat({ ...rest, company, ...beat });
    results.push(doc);
  }
  return results;
}

module.exports = { listLive, recordHeartbeat, recordHeartbeatsBatch, upsertRepSnapshot };
