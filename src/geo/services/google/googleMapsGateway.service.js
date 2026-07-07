const env = require('../../../config/env');
const GeoCache = require('../../models/GeoCache');
const { assertWithinDailyQuota, recordUsage } = require('../usageMetering.service');
const ApiError = require('../../../utils/ApiError');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isGoogleConfigured() {
  return !!(env.GOOGLE_MAPS_SERVER_API_KEY && String(env.GOOGLE_MAPS_SERVER_API_KEY).trim());
}

async function getCached(key) {
  const row = await GeoCache.findOne({ cacheKey: key, expiresAt: { $gt: new Date() } }).lean();
  return row?.payload ?? null;
}

async function setCache(key, api, payload, ttlMs = CACHE_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  await GeoCache.findOneAndUpdate(
    { cacheKey: key },
    { cacheKey: key, api, payload, expiresAt },
    { upsert: true, new: true }
  );
}

async function googleFetch(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new ApiError(502, `Google Maps API HTTP ${resp.status}`);
  }
  return resp.json();
}

async function geocode({ companyId, company, userId, address }) {
  await assertWithinDailyQuota(companyId, company);
  const cacheKey = `geocode:${String(address).trim().toLowerCase()}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  const key = encodeURIComponent(env.GOOGLE_MAPS_SERVER_API_KEY);
  const q = encodeURIComponent(String(address).trim());
  const data = await googleFetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`
  );

  if (data.status !== 'OK' || !data.results?.[0]) {
    throw new ApiError(502, `Geocoding failed: ${data.status || 'UNKNOWN'}`);
  }

  await recordUsage({ companyId, userId, api: 'geocoding', operation: 'geocode', units: 1 });
  const r = data.results[0];
  const result = {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    formattedAddress: r.formatted_address,
    provider: 'google'
  };
  await setCache(cacheKey, 'geocoding', result);
  return result;
}

async function reverseGeocode({ companyId, company, userId, lat, lng }) {
  await assertWithinDailyQuota(companyId, company);
  const cacheKey = `reverse:${lat},${lng}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  const key = encodeURIComponent(env.GOOGLE_MAPS_SERVER_API_KEY);
  const data = await googleFetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`
  );

  if (data.status !== 'OK' || !data.results?.[0]) {
    throw new ApiError(502, `Reverse geocoding failed: ${data.status || 'UNKNOWN'}`);
  }

  await recordUsage({ companyId, userId, api: 'geocoding', operation: 'reverseGeocode', units: 1 });
  const result = {
    formattedAddress: data.results[0].formatted_address,
    provider: 'google'
  };
  await setCache(cacheKey, 'geocoding', result);
  return result;
}

async function computeRoute({ companyId, company, userId, waypoints }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  const pts = Array.isArray(waypoints) ? waypoints.filter((w) => w?.lat != null && w?.lng != null) : [];
  if (pts.length < 2) {
    return { waypoints: pts, polyline: null, distanceMeters: null, durationSeconds: null, provider: 'google' };
  }

  const key = encodeURIComponent(env.GOOGLE_MAPS_SERVER_API_KEY);
  const origin = `${pts[0].lat},${pts[0].lng}`;
  const destination = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lng}`;
  const middle = pts.slice(1, -1).map((p) => `${p.lat},${p.lng}`);
  const wp = middle.length ? `&waypoints=${encodeURIComponent(middle.join('|'))}` : '';
  const data = await googleFetch(
    `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}${wp}&key=${key}`
  );

  if (data.status !== 'OK' || !data.routes?.[0]) {
    throw new ApiError(502, `Directions failed: ${data.status || 'UNKNOWN'}`);
  }

  await recordUsage({
    companyId,
    userId,
    api: 'routes',
    operation: 'computeRoutes',
    units: Math.max(1, pts.length)
  });

  const route = data.routes[0];
  const leg = route.legs?.[0];
  return {
    waypoints: pts,
    polyline: route.overview_polyline?.points || null,
    distanceMeters: leg?.distance?.value ?? null,
    durationSeconds: leg?.duration?.value ?? null,
    provider: 'google'
  };
}

async function distanceMatrix({ companyId, company, userId, origins, destinations }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  const key = encodeURIComponent(env.GOOGLE_MAPS_SERVER_API_KEY);
  const o = (origins || []).map((p) => `${p.lat},${p.lng}`).join('|');
  const d = (destinations || []).map((p) => `${p.lat},${p.lng}`).join('|');
  const data = await googleFetch(
    `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(o)}&destinations=${encodeURIComponent(d)}&key=${key}`
  );

  await recordUsage({
    companyId,
    userId,
    api: 'distance_matrix',
    operation: 'matrix',
    units: (origins?.length || 1) * (destinations?.length || 1)
  });

  return { rows: data.rows || [], provider: 'google', status: data.status };
}

async function placesAutocomplete({ companyId, company, userId, input, sessionToken }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  const key = encodeURIComponent(env.GOOGLE_MAPS_SERVER_API_KEY);
  const q = encodeURIComponent(String(input).trim());
  const session = sessionToken ? `&sessiontoken=${encodeURIComponent(sessionToken)}` : '';
  const data = await googleFetch(
    `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${q}${session}&key=${key}`
  );

  await recordUsage({
    companyId,
    userId,
    api: 'places',
    operation: 'autocomplete',
    units: 1,
    metadata: { sessionToken: sessionToken || null }
  });

  return {
    predictions: (data.predictions || []).map((p) => ({
      description: p.description,
      placeId: p.place_id
    })),
    provider: 'google',
    status: data.status
  };
}

module.exports = {
  isGoogleConfigured,
  geocode,
  reverseGeocode,
  computeRoute,
  distanceMatrix,
  placesAutocomplete
};
