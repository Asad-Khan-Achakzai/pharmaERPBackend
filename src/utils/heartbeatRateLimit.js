const ApiError = require('../utils/ApiError');

/** In-process sliding window rate limiter per user. */
const buckets = new Map();
const BURST_LIMIT = 6;
const WINDOW_MS = 60_000;
const MIN_GAP_MS = 5000;

function assertHeartbeatRateLimit(companyId, userId) {
  const key = `${companyId}:${userId}`;
  const now = Date.now();
  let entries = buckets.get(key) || [];
  entries = entries.filter((ts) => now - ts < WINDOW_MS);

  if (entries.length >= BURST_LIMIT) {
    throw new ApiError(429, 'Too many location updates — please slow down');
  }

  const last = entries[entries.length - 1];
  if (last && now - last < MIN_GAP_MS) {
    throw new ApiError(429, 'Location updates too frequent');
  }

  entries.push(now);
  buckets.set(key, entries);
}

module.exports = { assertHeartbeatRateLimit };
