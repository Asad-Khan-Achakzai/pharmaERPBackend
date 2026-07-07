const ApiError = require('../utils/ApiError');
const env = require('../config/env');

const BURST_LIMIT = 6;
const WINDOW_MS = 60_000;
const MIN_GAP_MS = 5000;

/** In-process fallback buckets when Redis is unavailable. */
const buckets = new Map();

let redisClient = null;
let redisReady = false;

async function initHeartbeatRateLimit() {
  if (!env.REDIS_URL || redisClient) return;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: env.REDIS_URL });
    redisClient.on('error', () => {
      redisReady = false;
    });
    await redisClient.connect();
    redisReady = true;
  } catch {
    redisClient = null;
    redisReady = false;
  }
}

async function assertRedisRateLimit(key, now) {
  const zkey = `hb:rl:${key}`;
  const minKey = `hb:gap:${key}`;

  const last = await redisClient.get(minKey);
  if (last && now - Number(last) < MIN_GAP_MS) {
    throw new ApiError(429, 'Location updates too frequent');
  }

  await redisClient.zRemRangeByScore(zkey, 0, now - WINDOW_MS);
  const count = await redisClient.zCard(zkey);
  if (count >= BURST_LIMIT) {
    throw new ApiError(429, 'Too many location updates — please slow down');
  }

  await redisClient.zAdd(zkey, [{ score: now, value: String(now) }]);
  await redisClient.expire(zkey, Math.ceil(WINDOW_MS / 1000));
  await redisClient.set(minKey, String(now), { EX: Math.ceil(MIN_GAP_MS / 1000) });
}

function assertMemoryRateLimit(key, now) {
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

async function assertHeartbeatRateLimit(companyId, userId) {
  const key = `${companyId}:${userId}`;
  const now = Date.now();

  if (redisReady && redisClient) {
    await assertRedisRateLimit(key, now);
    return;
  }

  assertMemoryRateLimit(key, now);
}

module.exports = { assertHeartbeatRateLimit, initHeartbeatRateLimit };
