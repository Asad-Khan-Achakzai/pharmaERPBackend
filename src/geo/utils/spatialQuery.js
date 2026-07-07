const EARTH_RADIUS_METERS = 6371000;

function parseBbox(input) {
  if (!input) return null;
  if (typeof input === 'object' && input.north != null) {
    return normalizeBbox(input);
  }
  if (typeof input === 'string') {
    const parts = input.split(',').map((p) => Number(p.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [west, south, east, north] = parts;
      return normalizeBbox({ west, south, east, north });
    }
  }
  return null;
}

function normalizeBbox({ north, south, east, west }) {
  const n = Number(north);
  const s = Number(south);
  const e = Number(east);
  const w = Number(west);
  if (![n, s, e, w].every(Number.isFinite)) return null;
  if (n <= s || e <= w) return null;
  return { north: n, south: s, east: e, west: w };
}

/** Expand a point by radius (meters) into an axis-aligned bounding box. */
function bboxFromCenter(lat, lng, radiusMeters = 250) {
  const r = Math.max(50, Math.min(Number(radiusMeters) || 250, 5000));
  const latRad = (lat * Math.PI) / 180;
  const dLat = (r / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const dLng = (r / (EARTH_RADIUS_METERS * Math.cos(latRad))) * (180 / Math.PI);
  return normalizeBbox({
    north: lat + dLat,
    south: lat - dLat,
    east: lng + dLng,
    west: lng - dLng
  });
}

function mergeBboxes(a, b) {
  if (!a) return b;
  if (!b) return a;
  return normalizeBbox({
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west)
  });
}

function latLngBoxFilter(bbox) {
  return {
    latitude: { $gte: bbox.south, $lte: bbox.north },
    longitude: { $gte: bbox.west, $lte: bbox.east }
  };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const aLat1 = toRad(lat1);
  const aLat2 = toRad(lat2);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(aLat1) * Math.cos(aLat2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(x));
}

function bboxPolygon(bbox) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [bbox.west, bbox.south],
        [bbox.east, bbox.south],
        [bbox.east, bbox.north],
        [bbox.west, bbox.north],
        [bbox.west, bbox.south]
      ]
    ]
  };
}

module.exports = {
  parseBbox,
  normalizeBbox,
  bboxFromCenter,
  mergeBboxes,
  latLngBoxFilter,
  haversineMeters,
  bboxPolygon,
  EARTH_RADIUS_METERS
};
