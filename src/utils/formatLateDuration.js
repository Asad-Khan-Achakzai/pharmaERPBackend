/**
 * Normalize `lateMinutes` from attendance (may include fractional minutes from seconds/ms).
 */
function normalizeLateMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;

  let v = Math.round(n);

  if (v >= 60_000) {
    const fromMs = Math.round(v / 60_000);
    if (fromMs >= 1 && fromMs <= 720) return fromMs;
  }

  if (v >= 120 && v <= 43_200 && v % 60 === 0) {
    const fromSec = v / 60;
    if (fromSec >= 1 && fromSec <= 180 && v > fromSec * 15) return fromSec;
  }

  return v;
}

/** Human-readable lateness for notifications (e.g. "5 minutes", "7h 28m"). */
function formatLateDuration(rawMinutes) {
  const minutes = normalizeLateMinutes(rawMinutes);
  if (minutes <= 0) return '';

  if (minutes < 60) {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (mins === 0) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  return `${hours}h ${mins}m`;
}

module.exports = { normalizeLateMinutes, formatLateDuration };
