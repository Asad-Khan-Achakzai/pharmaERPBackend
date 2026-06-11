const { GEO_FENCE_MODE, GEO_FENCE_RESULT } = require('../constants/enums');

const EARTH_RADIUS_METERS = 6371000;

/**
 * Haversine distance in meters between two WGS84 points.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  if (
    typeof lat1 !== 'number' ||
    typeof lng1 !== 'number' ||
    typeof lat2 !== 'number' ||
    typeof lng2 !== 'number'
  ) {
    return null;
  }
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

function isGeoFencingActive(company) {
  if (!company) return false;
  if (company.geoFencingEnabled !== true) return false;
  const mode = company.geoFenceMode || GEO_FENCE_MODE.OFF;
  return mode === GEO_FENCE_MODE.SOFT || mode === GEO_FENCE_MODE.STRICT;
}

/**
 * Evaluate visit GPS against verified doctor coordinates and company fence settings.
 */
function evaluateVisitGeoFence({ company, doctor, visitLat, visitLng }) {
  if (!isGeoFencingActive(company)) {
    return {
      applicable: false,
      distanceMeters: null,
      result: GEO_FENCE_RESULT.NOT_APPLICABLE,
      shouldBlock: false
    };
  }

  const docLat = doctor?.latitude;
  const docLng = doctor?.longitude;
  if (typeof docLat !== 'number' || typeof docLng !== 'number') {
    return {
      applicable: false,
      distanceMeters: null,
      result: GEO_FENCE_RESULT.NOT_APPLICABLE,
      shouldBlock: false
    };
  }

  const dist = distanceMeters(docLat, docLng, visitLat, visitLng);
  if (dist == null) {
    return {
      applicable: false,
      distanceMeters: null,
      result: GEO_FENCE_RESULT.NOT_APPLICABLE,
      shouldBlock: false
    };
  }

  const radius = Number(company.geoFenceRadiusMeters) > 0 ? Number(company.geoFenceRadiusMeters) : 150;
  const inside = dist <= radius;
  const mode = company.geoFenceMode || GEO_FENCE_MODE.OFF;
  const result = inside ? GEO_FENCE_RESULT.INSIDE_RADIUS : GEO_FENCE_RESULT.OUTSIDE_RADIUS;
  const shouldBlock = !inside && mode === GEO_FENCE_MODE.STRICT;

  return {
    applicable: true,
    distanceMeters: Math.round(dist),
    result,
    shouldBlock
  };
}

module.exports = {
  distanceMeters,
  isGeoFencingActive,
  evaluateVisitGeoFence,
  EARTH_RADIUS_METERS
};
