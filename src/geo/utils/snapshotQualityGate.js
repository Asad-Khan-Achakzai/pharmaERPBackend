const { haversineMeters } = require('../../utils/haversine');

function isDuplicate(incoming, existing) {
  if (!existing) return false;
  const ageMs = new Date(incoming.capturedAt).getTime() - new Date(existing.capturedAt).getTime();
  if (Math.abs(ageMs) >= 60_000) return false;
  const dist = haversineMeters(incoming.lat, incoming.lng, existing.lat, existing.lng);
  return dist < 8;
}

/** Always refresh snapshot when the fix is at least this much newer (live map freshness). */
const PERIODIC_REFRESH_MS = 180_000;

/**
 * Teleport gate: legit driving tops out ~39 m/s in production data, while
 * dual-device/mock-GPS fixes imply speeds orders of magnitude higher (often
 * with excellent accuracy, so accuracy cannot catch them). Blocking is capped
 * at 15 minutes so a genuinely relocated rep cannot be pinned to a stale
 * location forever.
 */
const TELEPORT_SPEED_MPS = 45;
const TELEPORT_MIN_DISPLACEMENT_M = 200;
const TELEPORT_MAX_BLOCK_MS = 15 * 60_000;

function isTeleport(incoming, existing) {
  const dtMs =
    new Date(incoming.capturedAt).getTime() - new Date(existing.capturedAt).getTime();
  if (dtMs <= 0 || dtMs >= TELEPORT_MAX_BLOCK_MS) return false;
  const movedM = haversineMeters(incoming.lat, incoming.lng, existing.lat, existing.lng);
  if (movedM <= TELEPORT_MIN_DISPLACEMENT_M) return false;
  return movedM / (dtMs / 1000) > TELEPORT_SPEED_MPS;
}

/**
 * Quality-gated snapshot update — prevents worse fixes from overwriting good pins.
 */
function shouldUpdateSnapshot(incoming, existing) {
  if (!existing) return true;

  const incomingAt = new Date(incoming.capturedAt).getTime();
  const existingAt = new Date(existing.capturedAt).getTime();
  if (incomingAt <= existingAt + 5000) return false;
  // Physically impossible hops never move the live pin — checked before the
  // periodic refresh so bogus fixes cannot ride the freshness path.
  if (isTeleport(incoming, existing)) return false;
  if (incomingAt >= existingAt + PERIODIC_REFRESH_MS) return true;
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

module.exports = { shouldUpdateSnapshot, isDuplicate, isTeleport };
