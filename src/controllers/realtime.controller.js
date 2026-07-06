const realtimeHub = require('../realtime/RealtimeHub');
const { attachSseClient } = require('../realtime/SseConnectionManager');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const ALLOWED_CHANNELS = new Set(['live-map']);

const stream = asyncHandler(async (req, res) => {
  const channel = req.query.channel || 'live-map';
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new ApiError(400, 'Invalid realtime channel');
  }

  attachSseClient(res, String(req.companyId), [channel]);
});

const stats = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, realtimeHub.stats());
});

module.exports = { stream, stats };
