const geoLiveService = require('../geo/services/geoLive.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const heartbeat = asyncHandler(async (req, res) => {
  const data = await geoLiveService.recordHeartbeat({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    timeZone: req.context.timeZone,
    lat: req.body.lat,
    lng: req.body.lng,
    accuracy: req.body.accuracy,
    capturedAt: req.body.capturedAt,
    clientUuid: req.body.clientUuid || req.headers['x-client-uuid'],
    confidence: req.body.confidence,
    speed: req.body.speed,
    heading: req.body.heading,
    trackingContext: req.body.trackingContext,
    expectedNextPingMs: req.body.expectedNextPingMs,
    source: req.body.source,
    battery: req.body.battery
  });
  ApiResponse.success(res, data, 'Heartbeat recorded');
});

const heartbeatsBatch = asyncHandler(async (req, res) => {
  const data = await geoLiveService.recordHeartbeatsBatch({
    companyId: req.companyId,
    company: req.context.company,
    userId: req.user.userId,
    timeZone: req.context.timeZone,
    heartbeats: req.body.heartbeats
  });
  ApiResponse.success(res, data, 'Heartbeats recorded');
});

const trackingDiagnostics = asyncHandler(async (req, res) => {
  const TrackingDiagnostic = require('../models/TrackingDiagnostic');
  const doc = await TrackingDiagnostic.create({
    companyId: req.companyId,
    userId: req.user.userId,
    type: req.body.type,
    capturedAt: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(),
    meta: req.body.meta && typeof req.body.meta === 'object' ? req.body.meta : {}
  });
  ApiResponse.success(res, doc.toObject(), 'Diagnostic recorded');
});

const live = asyncHandler(async (req, res) => {
  const result = await geoLiveService.listLive(
    req.companyId,
    req.user,
    req.context.timeZone,
    req.context.company,
    { ifNoneMatch: req.headers['if-none-match'] }
  );

  if (result.notModified) {
    res.setHeader('ETag', result.etag);
    return res.status(304).end();
  }

  res.setHeader('ETag', result.etag);
  ApiResponse.success(res, result.rows);
});

const liveSnapshot = asyncHandler(async (req, res) => {
  const result = await geoLiveService.listLive(
    req.companyId,
    req.user,
    req.context.timeZone,
    req.context.company,
    { ifNoneMatch: req.headers['if-none-match'] }
  );

  if (result.notModified) {
    res.setHeader('ETag', result.etag);
    return res.status(304).end();
  }

  res.setHeader('ETag', result.etag);
  ApiResponse.success(res, { rows: result.rows, etag: result.etag });
});

module.exports = { heartbeat, heartbeatsBatch, trackingDiagnostics, live, liveSnapshot };
