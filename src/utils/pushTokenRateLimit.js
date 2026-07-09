/**
 * Lightweight in-memory rate limit for push-token registration.
 * 10 requests / minute / user.
 */
const WINDOW_MS = 60_000;
const MAX = 10;
/** @type {Map<string, number[]>} */
const hits = new Map();

function assertPushTokenRateLimit(userId) {
  const key = String(userId || 'anon');
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) {
    const err = new Error('Too many push-token updates — try again shortly');
    err.statusCode = 429;
    throw err;
  }
  arr.push(now);
  hits.set(key, arr);
}

module.exports = { assertPushTokenRateLimit };
