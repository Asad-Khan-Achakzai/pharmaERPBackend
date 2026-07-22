const realtimeHub = require('../realtime/RealtimeHub');
const { attachSseClient } = require('../realtime/SseConnectionManager');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../middleware/asyncHandler');

const ALLOWED_CHANNELS = new Set(['live-map', 'notifications']);

const stream = asyncHandler(async (req, res) => {
  const raw = String(req.query.channel || 'live-map');
  const channels = [...new Set(raw.split(',').map((c) => c.trim()).filter(Boolean))];
  if (!channels.length) {
    throw new ApiError(400, 'Invalid realtime channel');
  }
  for (const channel of channels) {
    if (!ALLOWED_CHANNELS.has(channel)) {
      throw new ApiError(400, `Invalid realtime channel: ${channel}`);
    }
  }

  attachSseClient(res, String(req.companyId), channels);
});

const stats = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, realtimeHub.stats());
});

module.exports = { stream, stats };
