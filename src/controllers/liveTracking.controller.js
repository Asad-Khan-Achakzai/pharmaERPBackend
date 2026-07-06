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
    clientUuid: req.body.clientUuid || req.headers['x-client-uuid']
  });
  ApiResponse.success(res, data, 'Heartbeat recorded');
});

const live = asyncHandler(async (req, res) => {
  const data = await geoLiveService.listLive(
    req.companyId,
    req.user,
    req.context.timeZone,
    req.context.company,
    req.query
  );
  ApiResponse.success(res, data);
});

module.exports = { heartbeat, live };
