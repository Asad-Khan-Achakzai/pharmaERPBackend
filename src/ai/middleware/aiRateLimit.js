const ApiError = require('../../utils/ApiError');
const aiEnv = require('../config/aiEnv');

/** In-memory sliding window rate limiter per user (single-node). */
const buckets = new Map();

function pruneBucket(key, now, windowMs) {
  const arr = buckets.get(key) || [];
  const kept = arr.filter((t) => now - t < windowMs);
  if (kept.length) buckets.set(key, kept);
  else buckets.delete(key);
  return kept;
}

function aiRateLimit() {
  const limit = aiEnv.rateLimitPerMinute;
  const windowMs = 60_000;

  return (req, _res, next) => {
    const userId = req.user?.userId;
    if (!userId) return next(new ApiError(401, 'Authentication required'));

    const key = `${req.companyId}:${userId}`;
    const now = Date.now();
    const hits = pruneBucket(key, now, windowMs);
    if (hits.length >= limit) {
      const err = new ApiError(429, 'Too many AI Copilot requests. Please wait a moment and try again.');
      err.code = 'AI_RATE_LIMIT';
      return next(err);
    }
    hits.push(now);
    buckets.set(key, hits);
    return next();
  };
}

module.exports = { aiRateLimit };
