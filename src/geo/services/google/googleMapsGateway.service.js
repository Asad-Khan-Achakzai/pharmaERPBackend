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

async function geocode({ companyId, company, userId, address }) {
  await assertWithinDailyQuota(companyId, company);
  const cacheKey = `geocode:${String(address).trim().toLowerCase()}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }

  // Placeholder — wire to Google Geocoding REST when key is present
  await recordUsage({ companyId, userId, api: 'geocoding', operation: 'geocode', units: 1 });
  const result = { lat: null, lng: null, formattedAddress: address, provider: 'google', stub: true };
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

  await recordUsage({ companyId, userId, api: 'geocoding', operation: 'reverseGeocode', units: 1 });
  const result = { formattedAddress: `${lat}, ${lng}`, provider: 'google', stub: true };
  await setCache(cacheKey, 'geocoding', result);
  return result;
}

async function computeRoute({ companyId, company, userId, waypoints }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }
  await recordUsage({
    companyId,
    userId,
    api: 'routes',
    operation: 'computeRoutes',
    units: Math.max(1, waypoints?.length || 1)
  });
  return { waypoints, polyline: null, distanceMeters: null, durationSeconds: null, provider: 'google', stub: true };
}

async function distanceMatrix({ companyId, company, userId, origins, destinations }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }
  await recordUsage({
    companyId,
    userId,
    api: 'distance_matrix',
    operation: 'matrix',
    units: (origins?.length || 1) * (destinations?.length || 1)
  });
  return { rows: [], provider: 'google', stub: true };
}

async function placesAutocomplete({ companyId, company, userId, input, sessionToken }) {
  await assertWithinDailyQuota(companyId, company);
  if (!isGoogleConfigured()) {
    throw new ApiError(503, 'Google Maps server API is not configured');
  }
  await recordUsage({
    companyId,
    userId,
    api: 'places',
    operation: 'autocomplete',
    units: 1,
    metadata: { sessionToken: sessionToken || null }
  });
  return { predictions: [], provider: 'google', stub: true };
}

module.exports = {
  isGoogleConfigured,
  geocode,
  reverseGeocode,
  computeRoute,
  distanceMatrix,
  placesAutocomplete
};
