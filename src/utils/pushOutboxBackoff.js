/** Retry backoff: 30s → 2m → 10m → 30m → 2h (attempts 1..5). */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
const MAX_ATTEMPTS = 5;

function nextAttemptAt(attemptsAfterFailure) {
  const idx = Math.min(Math.max(attemptsAfterFailure, 1), BACKOFF_MS.length) - 1;
  return new Date(Date.now() + BACKOFF_MS[idx]);
}

function isPermanentPushError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.errorCode || '').toLowerCase();
  if (code.includes('devicenotregistered') || msg.includes('devicenotregistered')) return true;
  if (code.includes('invalidcredentials') || msg.includes('invalidcredentials')) return true;
  if (msg.includes('not a valid expo push token')) return true;
  return false;
}

module.exports = { BACKOFF_MS, MAX_ATTEMPTS, nextAttemptAt, isPermanentPushError };
