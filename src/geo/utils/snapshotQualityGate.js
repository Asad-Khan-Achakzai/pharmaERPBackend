const { haversineMeters } = require('../../utils/haversine');

function isDuplicate(incoming, existing) {
  if (!existing) return false;
  const ageMs = new Date(incoming.capturedAt).getTime() - new Date(existing.capturedAt).getTime();
  if (Math.abs(ageMs) >= 60_000) return false;
  const dist = haversineMeters(incoming.lat, incoming.lng, existing.lat, existing.lng);
  return dist < 8;
}

/**
 * Quality-gated snapshot update — prevents worse fixes from overwriting good pins.
 */
function shouldUpdateSnapshot(incoming, existing) {
  if (!existing) return true;

  const incomingAt = new Date(incoming.capturedAt).getTime();
  const existingAt = new Date(existing.capturedAt).getTime();
  if (incomingAt <= existingAt + 5000) return false;
  if (isDuplicate(incoming, existing)) return false;

  const incomingConf = incoming.confidence ?? 0;
  const existingConf = existing.confidence ?? 0;
  const incomingAcc = incoming.accuracy ?? 9999;
  const existingAcc = existing.accuracy ?? 9999;
  const movedM = haversineMeters(incoming.lat, incoming.lng, existing.lat, existing.lng);

  return (
    incomingConf > existingConf + 5 ||
    incomingAcc < existingAcc - 10 ||
    movedM > 20
  );
}

module.exports = { shouldUpdateSnapshot, isDuplicate };
