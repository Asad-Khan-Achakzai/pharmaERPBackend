const liveTrackingService = require('../services/liveTracking.service');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const heartbeat = asyncHandler(async (req, res) => {
  const data = await liveTrackingService.recordHeartbeat({
    companyId: req.companyId,
    userId: req.user.userId,
    lat: req.body.lat,
    lng: req.body.lng,
    accuracy: req.body.accuracy,
    capturedAt: req.body.capturedAt,
    clientUuid: req.body.clientUuid || req.headers['x-client-uuid']
  });
  ApiResponse.success(res, data, 'Heartbeat recorded');
});

const live = asyncHandler(async (req, res) => {
  const data = await liveTrackingService.listLive(req.companyId, req.user, req.query);
  ApiResponse.success(res, data);
});

module.exports = { heartbeat, live };
